import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type AgentConfiguration,
  type AgentOptions,
  type AgentPrMode,
  type IntegrationSummary,
  fetchAgent,
  fetchAgentOptions,
  fetchIntegrations,
  refreshSlackAgentOptions,
  saveAgent,
  slackChannelLabel,
} from "../agents-api";
import { slackContextConnectionStatus } from "../agent-create-presentation";
import { AppShell } from "../components/app-shell";
import { AgentSetupSkeleton } from "../components/screen-skeletons";
import {
  DatadogConnectionDialog,
} from "../components/datadog-site-dialog";
import { ClickStackConnectionDialog } from "../components/clickstack-connection-dialog";
import { CustomMcpConnectionDialog } from "../components/custom-mcp-dialog";
import {
  ChevronDownIcon,
  CogIcon,
  ProviderGlyph,
  RepositoryIcon,
  SearchIcon,
} from "../components/icons";
import type { ProviderGlyphId } from "../components/provider-glyphs";
import {
  Alert,
  Button,
  Checkbox,
  IconButton,
  Panel,
  Radio,
  SegmentedControl,
  SelectField,
  TextAreaField,
} from "../design-system";
import { useDocumentTitle } from "../use-document-title";

type InputKind = "sentry_issue" | "slack_channel";
type OutputMode = "thread" | "output_channel";
type Severity = "SEV-1" | "SEV-2" | "SEV-3";
type CreateStep = 1 | 2 | 3 | 4;

interface CreateDraft {
  inputKind: InputKind;
  sentryAccountId: string;
  sentryProjectResourceIds: string[];
  slackInputResourceId: string;
  outputMode: OutputMode;
  outputChannelResourceId: string;
  severities: Severity[];
  githubAccountId: string;
  repositoryIds: string[];
  prMode: AgentPrMode;
  contextAccountIds: string[];
  contextResourceIds: string[];
  instructions: string;
}

type SavedCreateDraft = Partial<CreateDraft> & {
  postScope?: "all" | "selected";
};

const EMPTY_OPTIONS: AgentOptions = {
  accounts: [],
  resources: [],
  repositories: [],
};

const DEFAULT_INSTRUCTIONS =
  "Investigate the root cause, assess severity and customer impact, then post a concise summary with evidence and recommended next steps. Use connected repositories and observability tools before proposing a fix.";

const DRAFT_STORAGE_KEY = "responder:new-agent-draft";
const DRAFT_STEP_STORAGE_KEY = "responder:new-agent-step";
const SEVERITY_OPTIONS: Array<{
  description: string;
  severity: Severity;
}> = [
  {
    severity: "SEV-1",
    description: "Critical outage or widespread customer impact.",
  },
  {
    severity: "SEV-2",
    description: "Significant degradation or limited customer impact.",
  },
  {
    severity: "SEV-3",
    description: "Minor impact with no immediate operational urgency.",
  },
];
const SEVERITIES = SEVERITY_OPTIONS.map(({ severity }) => severity);
const CREATE_STEPS: Array<{
  id: CreateStep;
  title: string;
  description: string;
}> = [
  { id: 1, title: "Input", description: "Trigger and source" },
  { id: 2, title: "Output", description: "Channel and routing" },
  { id: 3, title: "Agent context", description: "Tools and repositories" },
  { id: 4, title: "Prompt", description: "Investigation instructions" },
];

function resourcesOfKind(
  options: AgentOptions,
  kind: AgentOptions["resources"][number]["kind"],
) {
  return options.resources.filter((resource) => resource.kind === kind);
}

function accountsFor(
  options: AgentOptions,
  provider: AgentOptions["accounts"][number]["provider"],
) {
  return options.accounts.filter((account) => account.provider === provider);
}

function storageKey(base: string, agentId: string | undefined): string {
  return agentId ? `${base}:${agentId}` : base;
}

function readSavedDraft(key: string): SavedCreateDraft {
  try {
    const value = window.sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as SavedCreateDraft) : {};
  } catch {
    return {};
  }
}

function readSavedStep(key: string): CreateStep {
  const value = window.sessionStorage.getItem(key);
  return value === "2" || value === "3" || value === "4"
    ? Number(value) as CreateStep
    : 1;
}

function draftFromConfiguration(
  options: AgentOptions,
  configuration: AgentConfiguration | null,
): Partial<CreateDraft> {
  if (!configuration) return {};

  const sentryTrigger =
    configuration.trigger.kind === "sentry_issue"
      ? configuration.trigger
      : null;
  const slackTrigger =
    configuration.trigger.kind === "slack_channel"
      ? configuration.trigger
      : null;
  const outputReporting =
    configuration.reporting.mode === "thread"
      ? null
      : configuration.reporting;
  const selectedRepository = options.repositories.find((repository) =>
    configuration.repositoryIds.includes(repository.id),
  );

  return {
    inputKind: sentryTrigger ? "sentry_issue" : "slack_channel",
    sentryAccountId: sentryTrigger?.integrationAccountId,
    sentryProjectResourceIds: sentryTrigger
      ? options.resources
          .filter(
            (resource) =>
              resource.kind === "sentry_project" &&
              resource.integrationAccountId === sentryTrigger.integrationAccountId &&
              sentryTrigger.projectIds.includes(resource.externalId),
          )
          .map((resource) => resource.id)
      : undefined,
    slackInputResourceId: slackTrigger
      ? options.resources.find(
          (resource) =>
            resource.kind === "slack_channel" &&
            resource.integrationAccountId === slackTrigger.integrationAccountId &&
            resource.externalId === slackTrigger.channelId,
        )?.id
      : undefined,
    outputMode: configuration.reporting.mode === "thread"
      ? "thread"
      : "output_channel",
    outputChannelResourceId: outputReporting
      ? options.resources.find(
          (resource) =>
            resource.kind === "slack_channel" &&
            resource.integrationAccountId ===
              outputReporting.integrationAccountId &&
            resource.externalId === outputReporting.outputChannelId,
        )?.id
      : undefined,
    severities: outputReporting
      ? outputReporting.severities ?? [...SEVERITIES]
      : undefined,
    githubAccountId: selectedRepository?.integrationAccountId,
    repositoryIds: configuration.repositoryIds,
    prMode: configuration.prMode,
    contextAccountIds: configuration.contextAccountIds,
    contextResourceIds: configuration.contextResourceIds,
    instructions: configuration.instructions,
  };
}

function createInitialDraft(
  options: AgentOptions,
  saved: SavedCreateDraft,
  configuration: AgentConfiguration | null,
): CreateDraft {
  const configured = draftFromConfiguration(options, configuration);
  const sentryAccounts = accountsFor(options, "sentry");
  const sentryProjects = resourcesOfKind(options, "sentry_project");
  const slackChannels = resourcesOfKind(options, "slack_channel");
  const githubAccounts = accountsFor(options, "github");
  const firstSentryAccount =
    sentryAccounts.find((account) =>
      sentryProjects.some(
        (project) => project.integrationAccountId === account.id,
      ),
    ) ?? sentryAccounts[0];
  const projectsForAccount = sentryProjects.filter(
    (project) => project.integrationAccountId === firstSentryAccount?.id,
  );
  const repositoryIds =
    saved.repositoryIds?.filter((id) =>
      options.repositories.some((repository) => repository.id === id),
    ) ??
    configured.repositoryIds?.filter((id) =>
      options.repositories.some((repository) => repository.id === id),
    ) ??
    [];
  const configuredPrMode = saved.prMode ?? configured.prMode;

  return {
    inputKind: saved.inputKind ?? configured.inputKind ?? "sentry_issue",
    sentryAccountId:
      sentryAccounts.some((account) => account.id === saved.sentryAccountId)
        ? saved.sentryAccountId!
        : sentryAccounts.some(
              (account) => account.id === configured.sentryAccountId,
            )
          ? configured.sentryAccountId!
        : firstSentryAccount?.id ?? "",
    sentryProjectResourceIds:
      saved.sentryProjectResourceIds?.filter((id) =>
        sentryProjects.some((project) => project.id === id),
      ) ??
      configured.sentryProjectResourceIds?.filter((id) =>
        sentryProjects.some((project) => project.id === id),
      ) ??
      projectsForAccount.slice(0, 1).map((project) => project.id),
    slackInputResourceId:
      slackChannels.some((channel) => channel.id === saved.slackInputResourceId)
        ? saved.slackInputResourceId!
        : slackChannels.some(
              (channel) => channel.id === configured.slackInputResourceId,
            )
          ? configured.slackInputResourceId!
        : slackChannels[0]?.id ?? "",
    outputMode: saved.outputMode ?? configured.outputMode ?? "thread",
    outputChannelResourceId:
      slackChannels.some(
        (channel) => channel.id === saved.outputChannelResourceId,
      )
        ? saved.outputChannelResourceId!
        : slackChannels.some(
              (channel) => channel.id === configured.outputChannelResourceId,
            )
          ? configured.outputChannelResourceId!
        : slackChannels[0]?.id ?? "",
    severities:
      saved.postScope === "all"
        ? [...SEVERITIES]
        : saved.severities?.filter((severity) =>
              SEVERITIES.includes(severity),
            ) ??
          configured.severities?.filter((severity) =>
            SEVERITIES.includes(severity),
          ) ??
          [...SEVERITIES],
    githubAccountId:
      githubAccounts.some((account) => account.id === saved.githubAccountId)
        ? saved.githubAccountId!
        : githubAccounts.some(
              (account) => account.id === configured.githubAccountId,
            )
          ? configured.githubAccountId!
        : githubAccounts[0]?.id ?? "",
    repositoryIds,
    prMode:
      repositoryIds.length === 0
        ? "disabled"
        : configuredPrMode === "always"
          ? "always"
          : "manual",
    contextAccountIds:
      saved.contextAccountIds?.filter((id) =>
        options.accounts.some((account) => account.id === id),
      ) ??
      configured.contextAccountIds?.filter((id) =>
        options.accounts.some((account) => account.id === id),
      ) ??
      [],
    contextResourceIds:
      saved.contextResourceIds?.filter((id) =>
        slackChannels.some((channel) => channel.id === id),
      ) ??
      configured.contextResourceIds?.filter((id) =>
        slackChannels.some((channel) => channel.id === id),
      ) ??
      [],
    instructions:
      saved.instructions ?? configured.instructions ?? DEFAULT_INSTRUCTIONS,
  };
}

function connectionNotice(): {
  tone: "error" | "success";
  message: string;
} | null {
  const search = new URLSearchParams(window.location.search);
  const provider = search.get("integration");
  const status = search.get("status");
  if (!provider || !status) return null;

  const name =
    provider === "github"
      ? "GitHub"
      : provider === "slack"
        ? "Slack"
        : provider === "custom_mcp"
          ? "Custom MCP"
          : provider === "clickstack"
            ? "ClickStack / HyperDX"
            : provider;
  if (status === "connected") {
    if (provider === "slack") return null;
    return { tone: "success", message: `${name} connected. Continue setup.` };
  }
  return {
    tone: "error",
    message:
      search.get("reason") === "cancelled"
        ? `${name} connection was cancelled.`
        : `${name} could not be connected.`,
  };
}

function successfulConnectionReturn(provider: IntegrationSummary["id"]): boolean {
  const search = new URLSearchParams(window.location.search);
  return (
    search.get("integration") === provider &&
    search.get("status") === "connected"
  );
}

export function AgentCreatePage() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const isEditing = Boolean(agentId);
  const draftStorageKey = storageKey(DRAFT_STORAGE_KEY, agentId);
  const stepStorageKey = storageKey(DRAFT_STEP_STORAGE_KEY, agentId);
  const returnTo = agentId ? `/agents/${agentId}/edit` : "/agents/new";
  const githubJustConnected = successfulConnectionReturn("github");
  const datadogJustConnected = successfulConnectionReturn("datadog");
  const customMcpJustConnected = successfulConnectionReturn("custom_mcp");
  const clickStackJustConnected = successfulConnectionReturn("clickstack");
  const contextIntegrationJustConnected =
    githubJustConnected ||
    datadogJustConnected ||
    customMcpJustConnected ||
    clickStackJustConnected;
  const [options, setOptions] = useState<AgentOptions>(EMPTY_OPTIONS);
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [existingConfiguration, setExistingConfiguration] =
    useState<AgentConfiguration | null>(null);
  const [draft, setDraft] = useState<CreateDraft | null>(null);
  const [activeStep, setActiveStep] = useState<CreateStep>(
    contextIntegrationJustConnected
      ? 3
      : () => readSavedStep(stepStorageKey),
  );
  const [furthestStep, setFurthestStep] =
    useState<CreateStep>(
      contextIntegrationJustConnected
        ? 3
        : () => readSavedStep(stepStorageKey),
    );
  const [githubDialogOpen, setGithubDialogOpen] = useState(githubJustConnected);
  const [slackContextDialogOpen, setSlackContextDialogOpen] = useState(false);
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [promptStepReady, setPromptStepReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connectingProvider, setConnectingProvider] =
    useState<IntegrationSummary["id"] | null>(null);
  const [choosingDatadogSite, setChoosingDatadogSite] = useState(false);
  const [configuringCustomMcp, setConfiguringCustomMcp] = useState(false);
  const [connectingClickStack, setConnectingClickStack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshingSlackChannels, setRefreshingSlackChannels] = useState(false);
  const [slackRefreshError, setSlackRefreshError] = useState<string | null>(null);
  const slackRefreshInFlight = useRef<Promise<void> | null>(null);
  const connectingProviderRef = useRef<IntegrationSummary["id"] | null>(null);
  const [notice] = useState(connectionNotice);
  useDocumentTitle(isEditing ? "Edit agent" : "Create agent");

  useEffect(() => {
    if (!githubDialogOpen && !slackContextDialogOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setGithubDialogOpen(false);
        setSlackContextDialogOpen(false);
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [githubDialogOpen, slackContextDialogOpen]);

  useEffect(() => {
    if (activeStep !== 4 || promptStepReady) return;
    const timeout = window.setTimeout(() => setPromptStepReady(true), 500);
    return () => window.clearTimeout(timeout);
  }, [activeStep, promptStepReady]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchAgentOptions(),
      fetchIntegrations(),
      agentId ? fetchAgent(agentId) : Promise.resolve(null),
    ])
      .then(([loadedOptions, loadedIntegrations, agent]) => {
        if (cancelled) return;
        const loadedConfiguration = agent?.configuration ?? null;
        setOptions(loadedOptions);
        setIntegrations(loadedIntegrations);
        setExistingConfiguration(loadedConfiguration);
        const loadedDraft = createInitialDraft(
          loadedOptions,
          readSavedDraft(draftStorageKey),
          loadedConfiguration,
        );
        const connectedDatadog = accountsFor(
          loadedOptions,
          "datadog",
        )[0];
        if (
          datadogJustConnected &&
          connectedDatadog &&
          !loadedDraft.contextAccountIds.includes(connectedDatadog.id)
        ) {
          loadedDraft.contextAccountIds.push(connectedDatadog.id);
        }
        const connectedCustomMcpId = new URLSearchParams(
          window.location.search,
        ).get("integration_account_id");
        if (
          customMcpJustConnected &&
          connectedCustomMcpId &&
          loadedOptions.accounts.some(
            (account) =>
              account.id === connectedCustomMcpId &&
              account.provider === "custom_mcp",
          ) &&
          !loadedDraft.contextAccountIds.includes(connectedCustomMcpId)
        ) {
          loadedDraft.contextAccountIds.push(connectedCustomMcpId);
        }
        const connectedClickStack = accountsFor(
          loadedOptions,
          "clickstack",
        )[0];
        if (
          clickStackJustConnected &&
          connectedClickStack &&
          !loadedDraft.contextAccountIds.includes(connectedClickStack.id)
        ) {
          loadedDraft.contextAccountIds.push(connectedClickStack.id);
        }
        setDraft(loadedDraft);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to load agent setup",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    agentId,
    clickStackJustConnected,
    customMcpJustConnected,
    datadogJustConnected,
    draftStorageKey,
  ]);

  useEffect(() => {
    if (!draft) return;
    window.sessionStorage.setItem(draftStorageKey, JSON.stringify(draft));
  }, [draft, draftStorageKey]);

  useEffect(() => {
    window.sessionStorage.setItem(
      stepStorageKey,
      activeStep.toString(),
    );
  }, [activeStep, stepStorageKey]);

  const sentryAccounts = useMemo(
    () => accountsFor(options, "sentry"),
    [options],
  );
  const datadogAccounts = useMemo(
    () => accountsFor(options, "datadog"),
    [options],
  );
  const customMcpAccounts = useMemo(
    () => accountsFor(options, "custom_mcp"),
    [options],
  );
  const clickStackAccounts = useMemo(
    () => accountsFor(options, "clickstack"),
    [options],
  );
  const githubAccounts = useMemo(
    () => accountsFor(options, "github"),
    [options],
  );
  const slackAccounts = useMemo(
    () => accountsFor(options, "slack"),
    [options],
  );
  const sentryProjects = useMemo(
    () => resourcesOfKind(options, "sentry_project"),
    [options],
  );
  const slackChannels = useMemo(
    () => resourcesOfKind(options, "slack_channel"),
    [options],
  );

  if (loading || !draft) {
    return (
      <AppShell active="agents" density="create">
        <AgentSetupSkeleton />
      </AppShell>
    );
  }
  const currentDraft = draft;

  const selectedSentryProjects = sentryProjects.filter(
    (project) =>
      project.integrationAccountId === draft.sentryAccountId &&
      draft.sentryProjectResourceIds.includes(project.id),
  );
  const selectedSlackInput = slackChannels.find(
    (channel) => channel.id === draft.slackInputResourceId,
  );
  const selectedOutputChannel = slackChannels.find(
    (channel) => channel.id === draft.outputChannelResourceId,
  );
  const effectiveOutputMode: OutputMode =
    draft.inputKind === "slack_channel" ? draft.outputMode : "output_channel";
  const activeSentryAccount =
    sentryAccounts.find((account) => account.id === draft.sentryAccountId) ??
    sentryAccounts[0];
  const activeGithubAccount =
    githubAccounts.find((account) => account.id === draft.githubAccountId) ??
    githubAccounts[0];
  const githubRepositories = options.repositories.filter(
    (repository) =>
      repository.integrationAccountId === activeGithubAccount?.id,
  );
  const filteredGithubRepositories = githubRepositories.filter((repository) =>
    repository.fullName
      .toLocaleLowerCase()
      .includes(repositoryQuery.trim().toLocaleLowerCase()),
  );
  const selectedGithubAccountIds = [
    ...new Set(
      options.repositories
        .filter((repository) =>
          draft.repositoryIds.includes(repository.id),
        )
        .map((repository) => repository.integrationAccountId),
    ),
  ];
  const selectedGithubAccount = githubAccounts.find((account) =>
    selectedGithubAccountIds.includes(account.id),
  );
  const inputRequirement =
    draft.inputKind === "sentry_issue" && selectedSentryProjects.length === 0
      ? "Connect Sentry and choose at least one project."
      : draft.inputKind === "slack_channel" && !selectedSlackInput
        ? "Connect Slack and choose an alert channel."
        : null;
  const outputRequirement =
    effectiveOutputMode === "output_channel" && !selectedOutputChannel
      ? "Connect Slack and choose an output channel."
      : effectiveOutputMode === "output_channel" &&
          draft.severities.length === 0
        ? "Choose at least one severity."
        : null;
  const promptRequirement = !draft.instructions.trim()
    ? "Add an agent prompt."
    : null;
  const contextRequirement =
    draft.prMode !== "disabled" && draft.repositoryIds.length === 0
      ? "Choose at least one repository for pull request fixes."
      : null;
  const stepRequirements: Record<CreateStep, string | null> = {
    1: inputRequirement,
    2: outputRequirement,
    3: contextRequirement,
    4: promptRequirement,
  };
  const currentRequirement = stepRequirements[activeStep];
  const missingRequirement =
    inputRequirement ?? outputRequirement ?? contextRequirement ?? promptRequirement;

  function updateDraft(update: Partial<CreateDraft>) {
    setDraft((current) => (current ? { ...current, ...update } : current));
    setError(null);
  }

  function refreshSlackChannels(): Promise<void> {
    if (slackRefreshInFlight.current) return slackRefreshInFlight.current;

    setRefreshingSlackChannels(true);
    setSlackRefreshError(null);
    const refresh = refreshSlackAgentOptions()
      .then((freshOptions) => {
        const freshChannels = resourcesOfKind(freshOptions, "slack_channel");
        const freshChannelIds = new Set(
          freshChannels.map((channel) => channel.id),
        );
        setOptions(freshOptions);
        setDraft((current) => {
          if (!current) return current;
          return {
            ...current,
            slackInputResourceId: freshChannelIds.has(
              current.slackInputResourceId,
            )
              ? current.slackInputResourceId
              : freshChannels[0]?.id ?? "",
            outputChannelResourceId: freshChannelIds.has(
              current.outputChannelResourceId,
            )
              ? current.outputChannelResourceId
              : freshChannels[0]?.id ?? "",
            contextResourceIds: current.contextResourceIds.filter((id) =>
              freshChannelIds.has(id),
            ),
          };
        });
      })
      .catch((caught: unknown) => {
        setSlackRefreshError(
          caught instanceof Error
            ? caught.message
            : "Unable to refresh Slack channels",
        );
      })
      .finally(() => {
        setRefreshingSlackChannels(false);
        if (slackRefreshInFlight.current === refresh) {
          slackRefreshInFlight.current = null;
        }
      });
    slackRefreshInFlight.current = refresh;
    return refresh;
  }

  function integrationFor(provider: IntegrationSummary["id"]) {
    return integrations.find((integration) => integration.id === provider);
  }

  function connect(provider: IntegrationSummary["id"]) {
    if (connectingProviderRef.current) return;

    const integration = integrationFor(provider);
    if (!integration?.connectUrl) {
      setError(
        integration?.state === "coming_soon"
          ? `${integration.name} connection support is coming soon.`
          : `${integration?.name ?? provider} is not configured for this deployment.`,
      );
      return;
    }
    if (provider === "datadog" || provider === "clickstack") {
      window.sessionStorage.setItem(draftStorageKey, JSON.stringify(draft));
      if (provider === "datadog") setChoosingDatadogSite(true);
      else setConnectingClickStack(true);
      return;
    }
    if (provider === "custom_mcp") {
      window.sessionStorage.setItem(draftStorageKey, JSON.stringify(draft));
      setConfiguringCustomMcp(true);
      return;
    }
    connectingProviderRef.current = provider;
    setConnectingProvider(provider);
    window.sessionStorage.setItem(draftStorageKey, JSON.stringify(draft));
    const separator = integration.connectUrl.includes("?") ? "&" : "?";
    const params = new URLSearchParams({ returnTo });
    window.location.assign(`${integration.connectUrl}${separator}${params}`);
  }

  function toggleContextAccount(accountId: string) {
    updateDraft({
      contextAccountIds: currentDraft.contextAccountIds.includes(accountId)
        ? currentDraft.contextAccountIds.filter((id) => id !== accountId)
        : [...currentDraft.contextAccountIds, accountId],
    });
  }

  function toggleSlackContextResource(resourceId: string) {
    const resource = slackChannels.find((channel) => channel.id === resourceId);
    if (!resource) return;
    const selected = currentDraft.contextResourceIds.includes(resourceId);
    updateDraft({
      contextResourceIds: selected
        ? currentDraft.contextResourceIds.filter((id) => id !== resourceId)
        : [
            ...currentDraft.contextResourceIds.filter((id) => {
              const channel = slackChannels.find((item) => item.id === id);
              return (
                channel?.integrationAccountId === resource.integrationAccountId
              );
            }),
            resourceId,
          ],
    });
  }

  function showStep(step: CreateStep) {
    if (step > furthestStep) return;
    if (step === 4) setPromptStepReady(false);
    setActiveStep(step);
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function continueToNextStep() {
    if (currentRequirement) {
      setError(currentRequirement);
      return;
    }
    if (activeStep === 4) return;
    const nextStep = (activeStep + 1) as CreateStep;
    if (nextStep === 4) setPromptStepReady(false);
    setActiveStep(nextStep);
    setFurthestStep((current) =>
      Math.max(current, nextStep) as CreateStep
    );
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function returnToPreviousStep() {
    if (activeStep === 1) return;
    setActiveStep((activeStep - 1) as CreateStep);
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (
      activeStep !== 4 ||
      !promptStepReady ||
      !(submitter instanceof HTMLButtonElement) ||
      submitter.dataset.submitAgent !== "true"
    ) {
      if (activeStep < 4) continueToNextStep();
      return;
    }
    if (missingRequirement) {
      setError(missingRequirement);
      const blockedStep: CreateStep = inputRequirement
        ? 1
        : outputRequirement
          ? 2
          : contextRequirement
            ? 3
            : 4;
      setActiveStep(blockedStep);
      setFurthestStep((current) =>
        Math.max(current, blockedStep) as CreateStep
      );
      return;
    }

    const trigger =
      currentDraft.inputKind === "sentry_issue"
        ? {
            kind: "sentry_issue" as const,
            integrationAccountId: activeSentryAccount!.id,
            projectIds: selectedSentryProjects.map(
              (project) => project.externalId,
            ),
          }
        : {
            kind: "slack_channel" as const,
            integrationAccountId: selectedSlackInput!.integrationAccountId,
            channelId: selectedSlackInput!.externalId,
          };
    const reporting =
      effectiveOutputMode === "thread"
        ? ({ mode: "thread" } as const)
        : {
            mode: "output_channel" as const,
            integrationAccountId:
              selectedOutputChannel!.integrationAccountId,
            outputChannelId: selectedOutputChannel!.externalId,
            severities: currentDraft.severities,
          };
    const inputLabel =
      trigger.kind === "sentry_issue"
        ? "Sentry error"
        : slackChannelLabel(selectedSlackInput!.displayName);
    const contextAccountIds = new Set(currentDraft.contextAccountIds);
    if (trigger.kind === "sentry_issue") {
      contextAccountIds.add(trigger.integrationAccountId);
    }
    const configuration: AgentConfiguration = {
      name: existingConfiguration?.name ?? `${inputLabel} responder`,
      description:
        existingConfiguration?.description ??
        (trigger.kind === "sentry_issue"
          ? "Investigates new and regressed errors and reports actionable findings."
          : `Investigates alerts posted in ${slackChannelLabel(selectedSlackInput!.displayName)}.`),
      model: existingConfiguration?.model ?? "instance/default",
      instructions: currentDraft.instructions.trim(),
      enabled: existingConfiguration?.enabled ?? true,
      prMode: currentDraft.prMode,
      repositoryIds: currentDraft.repositoryIds,
      contextAccountIds: [...contextAccountIds],
      contextResourceIds: currentDraft.contextResourceIds,
      trigger,
      reporting,
    };

    setSaving(true);
    setError(null);
    try {
      const savedAgentId = await saveAgent(agentId, configuration);
      window.sessionStorage.removeItem(draftStorageKey);
      window.sessionStorage.removeItem(stepStorageKey);
      navigate(`/agents/${savedAgentId}`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : isEditing
            ? "Unable to save agent"
            : "Unable to create agent",
      );
    } finally {
      setSaving(false);
    }
  }

  const sentryConnected = sentryProjects.length > 0;
  const slackConnected = slackChannels.length > 0;
  const outputChannelSelected = effectiveOutputMode === "output_channel";
  const sentryIncluded =
    draft.inputKind === "sentry_issue" && Boolean(activeSentryAccount);
  const sentryContextConnected = Boolean(
    sentryAccounts[0] &&
      draft.contextAccountIds.includes(sentryAccounts[0].id),
  );
  const datadogContextConnected = Boolean(
    datadogAccounts[0] &&
      draft.contextAccountIds.includes(datadogAccounts[0].id),
  );
  const clickStackContextConnected = Boolean(
    clickStackAccounts[0] &&
      draft.contextAccountIds.includes(clickStackAccounts[0].id),
  );
  const selectedSlackContextChannels = slackChannels.filter((channel) =>
    draft.contextResourceIds.includes(channel.id),
  );
  const slackContextAvailable = slackAccounts.some(
    (account) => account.slackContextAvailable,
  );
  const connectedContextCount =
    Number(githubAccounts.length > 0) +
    Number(sentryIncluded || sentryContextConnected) +
    Number(selectedSlackContextChannels.length > 0) +
    Number(datadogContextConnected) +
    customMcpAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length +
    Number(clickStackContextConnected);

  return (
    <AppShell active="agents" density="create">
      <DatadogConnectionDialog
        connectUrl={integrationFor("datadog")?.connectUrl ?? ""}
        onCancel={() => setChoosingDatadogSite(false)}
        open={choosingDatadogSite}
        returnTo={returnTo}
      />
      <CustomMcpConnectionDialog
        connectUrl={integrationFor("custom_mcp")?.connectUrl ?? ""}
        onCancel={() => setConfiguringCustomMcp(false)}
        open={configuringCustomMcp}
        returnTo={returnTo}
      />
      <ClickStackConnectionDialog
        connectUrl={integrationFor("clickstack")?.connectUrl ?? ""}
        onCancel={() => setConnectingClickStack(false)}
        open={connectingClickStack}
        returnTo={returnTo}
      />
      <section className="createAgentHeading">
        <div>
          <h1>{isEditing ? `Edit ${existingConfiguration?.name ?? "agent"}` : "Create agent"}</h1>
          <p>
            {isEditing
              ? "Update what starts the agent, where its results go, and what context it can use."
              : "Choose what starts the agent, where its results go, and what context it can use."}
          </p>
        </div>
      </section>

      {notice ? (
        <Alert
          className="createNotice"
          role="status"
          title={notice.message}
          tone={notice.tone === "error" ? "danger" : "success"}
        />
      ) : null}
      {error ? (
        <Alert className="createNotice" role="alert" title={error} tone="danger" />
      ) : null}

      <form className="createAgentForm createStepper" onSubmit={submit}>
        <nav aria-label="Agent setup progress" className="createStepperRail">
          {CREATE_STEPS.map((step) => {
            const current = activeStep === step.id;
            const complete =
              step.id < furthestStep && !stepRequirements[step.id];
            return (
              <button
                aria-current={current ? "step" : undefined}
                className={[
                  "createStepperStep",
                  current ? "isCurrent" : "",
                  complete ? "isComplete" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={step.id > furthestStep}
                key={step.id}
                onClick={() => showStep(step.id)}
                type="button"
              >
                <span className="createStepperStep__marker">
                  {complete ? "✓" : step.id}
                </span>
                <span className="createStepperStep__copy">
                  <strong>{step.title}</strong>
                  <small>{step.description}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="createStepperPanel">
          {activeStep === 1 ? (
            <CreateSection
              description="What should start this agent?"
              title="Input"
            >
          <div className="createChoiceGrid">
            <ChoiceCard
              checked={draft.inputKind === "sentry_issue"}
              description="Run whenever Sentry reports a new or regressed error."
              name="inputKind"
              onChange={() =>
                updateDraft({
                  inputKind: "sentry_issue",
                  outputMode: "output_channel",
                })
              }
              title="Every Sentry error"
              value="sentry_issue"
            />
            <ChoiceCard
              checked={draft.inputKind === "slack_channel"}
              description="Run when an alert is posted in a channel."
              name="inputKind"
              onChange={() => {
                updateDraft({
                  inputKind: "slack_channel",
                  outputMode:
                    draft.outputMode === "output_channel"
                      ? "output_channel"
                      : "thread",
                });
                void refreshSlackChannels();
              }}
              title="Alert in a Slack channel"
              value="slack_channel"
            />
          </div>

          {draft.inputKind === "sentry_issue" ? (
            sentryConnected ? (
              <div className="connectedSetup">
                <ProviderMark provider="sentry" />
                <SelectField
                  className="createField createField--account"
                  label="Sentry account · connected"
                  onChange={(accountId) => {
                    const firstProject = sentryProjects.find(
                      (project) => project.integrationAccountId === accountId,
                    );
                    updateDraft({
                      sentryAccountId: accountId,
                      sentryProjectResourceIds: firstProject
                        ? [firstProject.id]
                        : [],
                    });
                  }}
                  options={sentryAccounts.map((account) => ({
                    label: account.displayName,
                    value: account.id,
                  }))}
                  value={draft.sentryAccountId}
                />
                <div className="projectPicker">
                  <span>Projects</span>
                  <div>
                    {sentryProjects
                      .filter(
                        (project) =>
                          project.integrationAccountId ===
                          draft.sentryAccountId,
                      )
                      .map((project) => (
                        <Checkbox
                          checked={draft.sentryProjectResourceIds.includes(
                            project.id,
                          )}
                          key={project.id}
                          label={project.displayName}
                          onChange={(event) =>
                            updateDraft({
                              sentryProjectResourceIds: event.target.checked
                                ? [
                                    ...draft.sentryProjectResourceIds,
                                    project.id,
                                  ]
                                : draft.sentryProjectResourceIds.filter(
                                    (id) => id !== project.id,
                                  ),
                            })
                          }
                        />
                      ))}
                  </div>
                </div>
              </div>
            ) : (
              <ConnectionPrompt
                actionLabel="Set up"
                integration={integrationFor("sentry")}
                isConnecting={connectingProvider === "sentry"}
                onConnect={() => connect("sentry")}
                provider="sentry"
                title="Connect Sentry to continue"
              />
            )
          ) : slackConnected ? (
            <Panel
              className="connectedSetup connectedSetup--channel"
              padding="compact"
              surface="raised"
            >
              <div className="slackConnectionHeader">
                <div className="slackConnectionIdentity">
                  <ProviderMark provider="slack" />
                  <div className="connectedAccount">
                    <span>Slack workspace</span>
                    <strong>
                      {
                        options.accounts.find(
                          (account) =>
                            account.id ===
                            selectedSlackInput?.integrationAccountId,
                        )?.displayName
                      }
                    </strong>
                  </div>
                </div>
                <Button
                  className="slackReconnectButton"
                  onClick={() => connect("slack")}
                  size="small"
                  variant="secondary"
                >
                  Reconnect
                </Button>
              </div>
              <ChannelPicker
                channels={slackChannels}
                label="Alert channel"
                onChange={(value) =>
                  updateDraft({ slackInputResourceId: value })
                }
                onOpen={refreshSlackChannels}
                refreshError={slackRefreshError}
                refreshing={refreshingSlackChannels}
                value={draft.slackInputResourceId}
              />
            </Panel>
          ) : (
            <ConnectionPrompt
              actionLabel="Set up"
              integration={integrationFor("slack")}
              isConnecting={connectingProvider === "slack"}
              onConnect={() => connect("slack")}
              provider="slack"
              title="Connect Slack to continue"
            />
          )}
            </CreateSection>
          ) : null}

          {activeStep === 2 ? (
            <CreateSection
              description="Where should results be posted?"
              title="Output"
            >
          {draft.inputKind === "sentry_issue" ? (
            <div className="requiredOutput">
              <div className="requiredOutput__label">
                <span className="radioMark radioMark--selected" />
                <strong>Post to an output channel</strong>
                <small>Required for Sentry input</small>
              </div>
              {slackConnected ? (
                <ChannelPicker
                  channels={slackChannels}
                  label="Output channel"
                  onChange={(value) =>
                    updateDraft({ outputChannelResourceId: value })
                  }
                  onOpen={refreshSlackChannels}
                  refreshError={slackRefreshError}
                  refreshing={refreshingSlackChannels}
                  value={draft.outputChannelResourceId}
                />
              ) : (
                <ConnectionPrompt
                  actionLabel="Set up"
                  compact
                  integration={integrationFor("slack")}
                  isConnecting={connectingProvider === "slack"}
                  onConnect={() => connect("slack")}
                  provider="slack"
                  title="Connect Slack for output"
                />
              )}
            </div>
          ) : (
            <>
              <div className="createChoiceGrid">
                <ChoiceCard
                  checked={draft.outputMode === "thread"}
                  description="Keep the investigation beside the original alert."
                  name="outputMode"
                  onChange={() => updateDraft({ outputMode: "thread" })}
                  title="Reply to the alert thread"
                  value="thread"
                />
                <ChoiceCard
                  checked={draft.outputMode === "output_channel"}
                  description="Route results to another Slack channel."
                  name="outputMode"
                  onChange={() => {
                    updateDraft({ outputMode: "output_channel" });
                    void refreshSlackChannels();
                  }}
                  title="Post to an output channel"
                  value="output_channel"
                />
              </div>
              {draft.outputMode === "output_channel" ? (
                slackConnected ? (
                  <ChannelPicker
                    channels={slackChannels}
                    label="Output channel"
                    onChange={(value) =>
                      updateDraft({ outputChannelResourceId: value })
                    }
                    onOpen={refreshSlackChannels}
                    refreshError={slackRefreshError}
                    refreshing={refreshingSlackChannels}
                    value={draft.outputChannelResourceId}
                  />
                ) : (
                  <ConnectionPrompt
                    actionLabel="Set up"
                    compact
                    integration={integrationFor("slack")}
                    isConnecting={connectingProvider === "slack"}
                    onConnect={() => connect("slack")}
                    provider="slack"
                    title="Connect Slack for output"
                  />
                )
              ) : null}
            </>
          )}

          {outputChannelSelected && slackConnected ? (
            <SeverityFilter draft={draft} updateDraft={updateDraft} />
          ) : null}
            </CreateSection>
          ) : null}

          {activeStep === 3 ? (
            <CreateSection
              description="Connect tools first. Configure capabilities when they become available."
              title="Agent context"
            >
              <div className="contextPanel">
                <div className="contextToolbar">
                  <span>
                    <strong>Integrations</strong>
                    <small>
                      The agent can inspect {connectedContextCount}{" "}
                      {connectedContextCount === 1 ? "source" : "sources"}.
                    </small>
                  </span>
                </div>

                <div className="contextList">
                  <ContextRow
                    action={
                      sentryIncluded ? (
                        <span className="contextAutomatic">Automatic</span>
                      ) : sentryContextConnected ? (
                        <Button
                          size="small"
                          onClick={() =>
                            toggleContextAccount(sentryAccounts[0]!.id)
                          }
                          variant="ghost"
                        >
                          Remove
                        </Button>
                      ) : sentryAccounts[0] ? (
                        <Button
                          size="small"
                          onClick={() =>
                            toggleContextAccount(sentryAccounts[0]!.id)
                          }
                          variant="secondary"
                        >
                          Add
                        </Button>
                      ) : (
                        <ConnectButton
                          integration={integrationFor("sentry")}
                          isConnecting={connectingProvider === "sentry"}
                          onClick={() => connect("sentry")}
                        />
                      )
                    }
                    detail={
                      sentryIncluded
                        ? "Issue, event, and trace context from the trigger"
                        : sentryAccounts[0]
                          ? `${sentryAccounts[0].displayName} · Issues, events, and traces`
                          : "Issues, events, and traces"
                    }
                    label="Sentry"
                    provider="sentry"
                    status={
                      sentryIncluded
                        ? "included"
                        : sentryContextConnected
                          ? "connected"
                          : sentryAccounts[0]
                            ? "available"
                            : "not_connected"
                    }
                  />

                  <ContextRow
                    action={
                      slackContextAvailable ? (
                        <Button
                          className="contextConfigureAction"
                          onClick={() => {
                            setSlackContextDialogOpen(true);
                            void refreshSlackChannels();
                          }}
                          size="small"
                          variant="ghost"
                        >
                          <span>Configure</span>
                          <CogIcon />
                        </Button>
                      ) : (
                        <Button
                          loading={connectingProvider === "slack"}
                          onClick={() => connect("slack")}
                          size="small"
                          variant="primary"
                        >
                          {slackAccounts.length > 0 ? "Reconnect" : "Connect"}
                        </Button>
                      )
                    }
                    detail={
                      selectedSlackContextChannels.length > 0
                        ? `${selectedSlackContextChannels.length} ${
                            selectedSlackContextChannels.length === 1
                              ? "channel"
                              : "channels"
                          } selected · Read-only message and thread history`
                        : "Read-only message and thread history from selected channels"
                    }
                    label="Slack"
                    provider="slack"
                    status={
                      slackContextConnectionStatus({
                        available: slackContextAvailable,
                        selectedChannelCount:
                          selectedSlackContextChannels.length,
                      })
                    }
                  />

                  {slackContextDialogOpen ? (
                    <div
                      className="configurationDialogBackdrop"
                      onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                          setSlackContextDialogOpen(false);
                        }
                      }}
                    >
                      <section
                        aria-labelledby="slack-context-configuration-title"
                        aria-modal="true"
                        className="configurationDialog"
                        role="dialog"
                      >
                        <header className="configurationDialog__header">
                          <ProviderMark provider="slack" />
                          <span>
                            <strong id="slack-context-configuration-title">
                              Configure Slack context
                            </strong>
                            <small>
                              Choose one or more channels from one Slack workspace.
                            </small>
                          </span>
                          <IconButton
                            aria-label="Close Slack context configuration"
                            autoFocus
                            onClick={() => setSlackContextDialogOpen(false)}
                            size="small"
                            variant="ghost"
                          >
                            ×
                          </IconButton>
                        </header>
                        <div className="configurationDialog__body">
                          <div className="projectPicker slackContextPicker">
                            <span>Channels</span>
                            <div>
                              {slackChannels
                                .filter((channel) =>
                                  slackAccounts.some(
                                    (account) =>
                                      account.id ===
                                        channel.integrationAccountId &&
                                      account.slackContextAvailable,
                                  ),
                                )
                                .map((channel) => {
                                  const account = slackAccounts.find(
                                    (item) =>
                                      item.id === channel.integrationAccountId,
                                  );
                                  return (
                                    <Checkbox
                                      checked={draft.contextResourceIds.includes(
                                        channel.id,
                                      )}
                                      description={
                                        slackAccounts.length > 1
                                          ? account?.displayName
                                          : undefined
                                      }
                                      key={channel.id}
                                      label={slackChannelLabel(
                                        channel.displayName,
                                      )}
                                      onChange={() =>
                                        toggleSlackContextResource(channel.id)
                                      }
                                    />
                                  );
                                })}
                            </div>
                          </div>
                          {slackRefreshError ? (
                            <Alert
                              role="alert"
                              title={slackRefreshError}
                              tone="danger"
                            />
                          ) : null}
                        </div>
                        <footer className="configurationDialog__footer">
                          <span>
                            {selectedSlackContextChannels.length} selected
                          </span>
                          <Button
                            onClick={() => setSlackContextDialogOpen(false)}
                            size="small"
                            variant="primary"
                          >
                            Done
                          </Button>
                        </footer>
                      </section>
                    </div>
                  ) : null}

                  <ContextRow
                    action={
                      githubAccounts.length > 0 ? (
                        <Button
                          className="contextConfigureAction"
                          onClick={() => setGithubDialogOpen(true)}
                          size="small"
                          variant="ghost"
                        >
                          <span>Configure</span>
                          <CogIcon />
                        </Button>
                      ) : (
                        <ConnectButton
                          integration={integrationFor("github")}
                          isConnecting={connectingProvider === "github"}
                          onClick={() => connect("github")}
                        />
                      )
                    }
                    detail={
                      githubAccounts.length > 0
                        ? `${
                            selectedGithubAccountIds.length > 1
                              ? `${selectedGithubAccountIds.length} organizations`
                              : selectedGithubAccount?.displayName ??
                                activeGithubAccount?.displayName ??
                                "GitHub"
                          } · ${draft.repositoryIds.length} ${
                            draft.repositoryIds.length === 1
                              ? "repository"
                              : "repositories"
                          } selected`
                        : "Repositories and pull request fixes"
                    }
                    label="GitHub"
                    provider="github"
                    status={
                      githubAccounts.length > 0 ? "connected" : "not_connected"
                    }
                  />

                      {githubDialogOpen && activeGithubAccount ? (
                        <div
                          className="configurationDialogBackdrop"
                          onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                              setGithubDialogOpen(false);
                            }
                          }}
                        >
                          <section
                            aria-labelledby="github-configuration-title"
                            aria-modal="true"
                            className="configurationDialog"
                            role="dialog"
                          >
                            <header className="configurationDialog__header">
                              <ProviderMark provider="github" />
                              <span>
                                <strong id="github-configuration-title">
                                  Configure GitHub
                                </strong>
                                <small>
                                  Choose the repositories and pull request behavior
                                  for this agent.
                                </small>
                              </span>
                              <IconButton
                                aria-label="Close GitHub configuration"
                                autoFocus
                                onClick={() => setGithubDialogOpen(false)}
                                size="small"
                                variant="ghost"
                              >
                                ×
                              </IconButton>
                            </header>
                            <div className="configurationDialog__body">
                          <div className="contextSettingRow">
                            <span>
                              <strong>Repositories</strong>
                              <small>
                                {draft.repositoryIds.length > 0
                                  ? `${draft.repositoryIds.length} selected`
                                  : "Choose the code this agent may inspect"}
                              </small>
                            </span>
                          </div>

                          <div className="repositoryPicker">
                              <div className="repositoryPicker__controls">
                                <GitHubOrganizationPicker
                                  accounts={githubAccounts}
                                  onChange={(accountId) => {
                                    updateDraft({ githubAccountId: accountId });
                                    setRepositoryQuery("");
                                  }}
                                  value={activeGithubAccount.id}
                                />
                                <label className="repositorySearch">
                                  <SearchIcon />
                                  <input
                                    aria-label="Search repositories"
                                    onChange={(event) =>
                                      setRepositoryQuery(event.target.value)
                                    }
                                    placeholder="Search repositories"
                                    type="search"
                                    value={repositoryQuery}
                                  />
                                </label>
                              </div>
                              <div className="repositoryConnectList">
                                {filteredGithubRepositories.map((repository) => {
                                  const selected = draft.repositoryIds.includes(
                                    repository.id,
                                  );
                                  const repositoryName =
                                    repository.fullName.split("/").at(-1) ??
                                    repository.fullName;

                                  return (
                                    <div
                                      className="repositoryConnectRow"
                                      key={repository.id}
                                    >
                                      <span className="repositoryConnectRow__icon">
                                        <RepositoryIcon />
                                      </span>
                                      <span className="repositoryConnectRow__copy">
                                        <strong>{repositoryName}</strong>
                                        <small>
                                          {repository.private ? "Private" : "Public"} ·{" "}
                                          {repository.defaultBranch}
                                        </small>
                                      </span>
                                      <Button
                                        aria-pressed={selected}
                                        className={`repositoryConnectButton ${
                                          selected ? "isConnected" : ""
                                        }`}
                                        onClick={() => {
                                          const repositoryIds = selected
                                            ? draft.repositoryIds.filter(
                                                (id) => id !== repository.id,
                                              )
                                            : [
                                                ...draft.repositoryIds,
                                                repository.id,
                                              ];
                                          updateDraft({
                                            repositoryIds,
                                            prMode:
                                              repositoryIds.length === 0
                                                ? "disabled"
                                                : draft.prMode === "always"
                                                  ? "always"
                                                  : "manual",
                                          });
                                        }}
                                        size="small"
                                        variant={
                                          selected ? "secondary" : "primary"
                                        }
                                      >
                                        {selected ? "Selected" : "Select"}
                                      </Button>
                                    </div>
                                  );
                                })}
                                {githubRepositories.length === 0 ? (
                                  <p>No repositories are available for this organization.</p>
                                ) : filteredGithubRepositories.length === 0 ? (
                                  <p>No repositories match “{repositoryQuery}”.</p>
                                ) : null}
                              </div>
                            </div>

                          <div className="contextSettingRow">
                            <span>
                              <strong>Pull request fixes</strong>
                              <small>
                                What should happen when the agent finds a safe fix?
                              </small>
                            </span>
                            <SegmentedControl
                              aria-label="Pull request fix behavior"
                              onChange={(prMode) => updateDraft({ prMode })}
                              options={[
                                { label: "On request", value: "manual" },
                                { label: "Always", value: "always" },
                              ]}
                              value={draft.prMode === "always" ? "always" : "manual"}
                            />
                          </div>
                            </div>
                            <footer className="configurationDialog__footer">
                              <span>
                                {draft.repositoryIds.length} selected
                              </span>
                              <Button
                                onClick={() => setGithubDialogOpen(false)}
                                size="small"
                                variant="primary"
                              >
                                Done
                              </Button>
                            </footer>
                          </section>
                        </div>
                      ) : null}

                  <ContextRow
                    action={
                      datadogContextConnected ? (
                        <Button
                          size="small"
                          onClick={() =>
                            toggleContextAccount(datadogAccounts[0]!.id)
                          }
                          variant="ghost"
                        >
                          Remove
                        </Button>
                      ) : datadogAccounts[0] ? (
                        <Button
                          size="small"
                          onClick={() =>
                            toggleContextAccount(datadogAccounts[0]!.id)
                          }
                          variant="secondary"
                        >
                          Add
                        </Button>
                      ) : (
                        <ConnectButton
                          integration={integrationFor("datadog")}
                          isConnecting={connectingProvider === "datadog"}
                          onClick={() => connect("datadog")}
                        />
                      )
                    }
                    detail={
                      datadogAccounts[0]
                        ? `${datadogAccounts[0].displayName} · Logs, traces, monitors, and service health`
                        : "Logs, traces, monitors, and service health"
                    }
                    label="Datadog"
                    provider="datadog"
                    status={
                      datadogContextConnected
                        ? "connected"
                        : datadogAccounts[0]
                          ? "available"
                          : "not_connected"
                    }
                  />
                  {customMcpAccounts.map((account) => {
                    const connected = draft.contextAccountIds.includes(account.id);
                    return (
                      <ContextRow
                        action={
                          <Button
                            size="small"
                            onClick={() => toggleContextAccount(account.id)}
                            variant={connected ? "ghost" : "secondary"}
                          >
                            {connected ? "Remove" : "Add"}
                          </Button>
                        }
                        detail="Remote tools exposed by this MCP server"
                        key={account.id}
                        label={account.displayName}
                        provider="custom_mcp"
                        status={connected ? "connected" : "available"}
                      />
                    );
                  })}
                  <ContextRow
                    action={
                      <ConnectButton
                        integration={integrationFor("custom_mcp")}
                        isConnecting={false}
                        onClick={() => connect("custom_mcp")}
                      />
                    }
                    detail="API token or OAuth 2.0"
                    label="Custom MCP"
                    provider="custom_mcp"
                    status="not_connected"
                  />
                  <ContextRow
                    action={
                      clickStackContextConnected ? (
                        <Button
                          size="small"
                          onClick={() =>
                            toggleContextAccount(clickStackAccounts[0]!.id)
                          }
                          variant="ghost"
                        >
                          Remove
                        </Button>
                      ) : clickStackAccounts[0] ? (
                        <Button
                          size="small"
                          onClick={() =>
                            toggleContextAccount(clickStackAccounts[0]!.id)
                          }
                          variant="secondary"
                        >
                          Add
                        </Button>
                      ) : (
                        <ConnectButton
                          integration={integrationFor("clickstack")}
                          isConnecting={connectingProvider === "clickstack"}
                          onClick={() => connect("clickstack")}
                        />
                      )
                    }
                    detail={
                      clickStackAccounts[0]
                        ? `${clickStackAccounts[0].displayName} · Logs, traces, metrics, and service health`
                        : "Logs, traces, metrics, and service health"
                    }
                    label="ClickStack / HyperDX"
                    provider="clickstack"
                    status={
                      clickStackContextConnected
                        ? "connected"
                        : clickStackAccounts[0]
                          ? "available"
                          : "not_connected"
                    }
                  />
                </div>
              </div>
            </CreateSection>
          ) : null}

          {activeStep === 4 ? (
            <CreateSection
              description="Tell the agent how to investigate and respond."
              title="Prompt"
            >
              <TextAreaField
                className="promptField"
                error={
                  error === promptRequirement
                    ? promptRequirement ?? undefined
                    : undefined
                }
                hint={`The agent can use only the context connected above · ${draft.instructions.length.toLocaleString()} / 4,000`}
                label="Agent prompt"
                maxLength={4_000}
                onChange={(event) =>
                  updateDraft({ instructions: event.target.value })
                }
                rows={5}
                value={draft.instructions}
              />
            </CreateSection>
          ) : null}

          <footer className="createAgentActions">
            {currentRequirement || activeStep >= 3 ? (
              <span
                aria-live="polite"
                className={
                  currentRequirement
                    ? "createRequirement"
                    : "createRequirement isReady"
                }
              >
                {currentRequirement ??
                  (activeStep === 3
                    ? "Context is optional. Add only what the agent needs."
                    : "All required setup is complete.")}
              </span>
            ) : null}
            {activeStep === 1 ? (
              <Link
                className="dsButton dsButton--secondary dsButton--medium"
                to={agentId ? `/agents/${agentId}` : "/agents"}
              >
                Cancel
              </Link>
            ) : (
              <Button onClick={returnToPreviousStep} variant="secondary">
                Back
              </Button>
            )}
            {activeStep < 4 ? (
              <Button
                disabled={Boolean(currentRequirement)}
                onClick={continueToNextStep}
                variant="primary"
              >
                Continue
              </Button>
            ) : (
              <Button
                data-submit-agent="true"
                disabled={
                  Boolean(missingRequirement) || !promptStepReady || saving
                }
                loading={saving}
                type="submit"
                variant="primary"
              >
                {isEditing ? "Save changes" : "Create agent"}
              </Button>
            )}
          </footer>
        </div>
      </form>
    </AppShell>
  );
}

function CreateSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="createSection">
      <header>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      <Panel className="createSection__body" padding="default" surface="base">
        {children}
      </Panel>
    </section>
  );
}

function ChoiceCard({
  checked,
  description,
  name,
  onChange,
  title,
  value,
}: {
  checked: boolean;
  description: string;
  name: string;
  onChange: () => void;
  title: string;
  value: string;
}) {
  return (
    <Radio
      checked={checked}
      className="createChoice"
      description={description}
      label={title}
      name={name}
      onChange={onChange}
      value={value}
    />
  );
}

type ProviderId = Exclude<ProviderGlyphId, "google">;

function ProviderMark({
  connected = false,
  provider,
}: {
  connected?: boolean;
  provider: ProviderId;
}) {
  return (
    <ProviderGlyph
      className={`providerMark providerMark--${provider} ${
        connected ? "isConnected" : ""
      }`}
      decorative
      provider={provider}
    />
  );
}

function ConnectionPrompt({
  actionLabel,
  compact = false,
  integration,
  isConnecting,
  onConnect,
  provider,
  title,
}: {
  actionLabel: string;
  compact?: boolean;
  integration: IntegrationSummary | undefined;
  isConnecting: boolean;
  onConnect: () => void;
  provider: "slack" | "sentry";
  title: string;
}) {
  const comingSoon = integration?.state === "coming_soon";
  return (
    <div className={`connectionPrompt ${compact ? "isCompact" : ""}`}>
      <ProviderMark provider={provider} />
      <span className="connectionPrompt__copy">
        <strong>{title}</strong>
      </span>
      <Button
        disabled={comingSoon || isConnecting}
        loading={isConnecting}
        onClick={onConnect}
        size="small"
        variant="primary"
      >
        {isConnecting ? "Connecting…" : comingSoon ? "Coming soon" : actionLabel}
      </Button>
    </div>
  );
}

function ChannelPicker({
  channels,
  label,
  onChange,
  onOpen,
  refreshError,
  refreshing = false,
  value,
}: {
  channels: AgentOptions["resources"];
  label: string;
  onChange: (value: string) => void;
  onOpen?: () => void | Promise<void>;
  refreshError?: string | null;
  refreshing?: boolean;
  value: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = channels.find((channel) => channel.id === value);
  const filteredChannels = channels.filter((channel) =>
    channel.displayName
      .replace(/^#/, "")
      .toLocaleLowerCase()
      .includes(query.trim().replace(/^#/, "").toLocaleLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
        setQuery("");
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="channelPicker createField createField--grow" ref={rootRef}>
      <span>{label}</span>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="channelPicker__trigger"
        onClick={() => {
          const opening = !open;
          setOpen(opening);
          if (opening) void onOpen?.();
        }}
        type="button"
      >
        <span>
          {selected
            ? slackChannelLabel(selected.displayName)
            : "Choose a channel"}
        </span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="channelPicker__popover">
          <input
            aria-label="Search channels"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search channels…"
            type="search"
            value={query}
          />
          <div className="channelPicker__options" role="listbox">
            {refreshing ? <p>Refreshing channels…</p> : null}
            {!refreshing && refreshError ? (
              <p>{refreshError}. Showing the last available list.</p>
            ) : null}
            {filteredChannels.map((channel) => (
              <button
                aria-selected={channel.id === value}
                className={channel.id === value ? "isSelected" : ""}
                key={channel.id}
                onClick={() => {
                  onChange(channel.id);
                  setOpen(false);
                  setQuery("");
                }}
                role="option"
                type="button"
              >
                <span>{slackChannelLabel(channel.displayName)}</span>
                {channel.id === value ? <span aria-hidden="true">✓</span> : null}
              </button>
            ))}
            {filteredChannels.length === 0 ? (
              <p>No channels match “{query}”.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GitHubOrganizationPicker({
  accounts,
  onChange,
  value,
}: {
  accounts: AgentOptions["accounts"];
  onChange: (value: string) => void;
  value: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = accounts.find((account) => account.id === value);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="repositoryOrganizationPicker" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="channelPicker__trigger repositoryOrganizationPicker__trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <ProviderGlyph provider="github" />
        <span className="repositoryOrganizationPicker__label">
          {selected?.displayName ?? "Choose an organization"}
        </span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="channelPicker__popover repositoryOrganizationPicker__popover">
          <div className="channelPicker__options" role="listbox">
            {accounts.map((account) => (
              <button
                aria-selected={account.id === value}
                className={account.id === value ? "isSelected" : ""}
                key={account.id}
                onClick={() => {
                  onChange(account.id);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <span>{account.displayName}</span>
                {account.id === value ? (
                  <span aria-hidden="true">✓</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SeverityFilter({
  draft,
  updateDraft,
}: {
  draft: CreateDraft;
  updateDraft: (update: Partial<CreateDraft>) => void;
}) {
  return (
    <fieldset className="severityFilter">
      <legend>What should be posted?</legend>
      <div className="severityChecks">
        {SEVERITY_OPTIONS.map(({ description, severity }) => (
          <Checkbox
            checked={draft.severities.includes(severity)}
            className="severityChoice"
            description={description}
            key={severity}
            label={severity}
            onChange={(event) =>
              updateDraft({
                severities: event.target.checked
                  ? [...draft.severities, severity]
                  : draft.severities.filter((item) => item !== severity),
              })
            }
          />
        ))}
      </div>
    </fieldset>
  );
}

function ContextRow({
  action,
  detail,
  label,
  provider,
  status,
}: {
  action: ReactNode;
  detail: string;
  label: string;
  provider:
    | "github"
    | "slack"
    | "sentry"
    | "datadog"
    | "custom_mcp"
    | "clickstack";
  status: "available" | "connected" | "included" | "not_connected";
}) {
  const statusLabel = {
    available: "Available",
    connected: "",
    included: "Included",
    not_connected: "Not connected",
  }[status];

  return (
    <div className="contextRow">
      <ProviderMark
        connected={status === "connected" || status === "included"}
        provider={provider}
      />
      <span className="contextRow__copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <small
        className={`contextStatus ${
          status === "available" || status === "not_connected" ? "isMuted" : ""
        }`}
      >
        {statusLabel}
      </small>
      <span className="contextRow__action">{action}</span>
    </div>
  );
}

function ConnectButton({
  integration,
  isConnecting,
  onClick,
}: {
  integration: IntegrationSummary | undefined;
  isConnecting: boolean;
  onClick: () => void;
}) {
  const comingSoon = integration?.state === "coming_soon";
  const setupRequired = integration?.state === "setup_required";
  return (
    <Button
      disabled={comingSoon || isConnecting}
      loading={isConnecting}
      onClick={onClick}
      size="small"
      variant="primary"
    >
      {isConnecting
        ? "Connecting…"
        : comingSoon
          ? "Coming soon"
          : setupRequired
            ? "Setup required"
            : "Connect"}
    </Button>
  );
}
