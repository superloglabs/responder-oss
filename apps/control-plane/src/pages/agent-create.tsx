import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { defaultLinearIssueTemplate } from "@responder/core/agents/config";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type AgentConfiguration,
  type AgentOptions,
  type IntegrationSummary,
  fetchAgent,
  fetchAgentOptions,
  fetchIntegrations,
  createWorkspaceSecret,
  refreshGitHubAgentOptions,
  refreshSlackAgentOptions,
  saveAgent,
  slackChannelLabel,
} from "../agents-api";
import { defaultAgentContext } from "../agent-context-defaults";
import { AppShell } from "../components/app-shell";
import {
  AgentContextIntegrationControls as ContextIntegrationControls,
  AgentContextProviderMark as ProviderMark,
  AgentContextRow as ContextRow,
} from "../components/agent-context-controls";
import { AgentSetupSkeleton } from "../components/screen-skeletons";
import {
  DatadogConnectionDialog,
} from "../components/datadog-site-dialog";
import { ClickStackConnectionDialog } from "../components/clickstack-connection-dialog";
import { AwsConnectionDialog } from "../components/aws-connection-dialog";
import { CustomMcpConnectionDialog } from "../components/custom-mcp-dialog";
import { UpstashConnectionDialog } from "../components/upstash-connection-dialog";
import { LangfuseConnectionDialog } from "../components/langfuse-connection-dialog";
import {
  ChevronDownIcon,
  ProviderGlyph,
  RepositoryIcon,
  SearchIcon,
} from "../components/icons";
import {
  providerDisplayName,
} from "../components/provider-glyphs";
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
import {
  draftForSessionStorage,
  workspaceSecretRecordIdsForDraft,
  type CreateDraft,
  type OutputMode,
  type SavedCreateDraft,
  type Severity,
} from "./agent-create-draft";

type CreateStep = 1 | 2 | 3 | 4;
type ContextCategory =
  | "Observability"
  | "Code & deployment"
  | "Communication & workflow"
  | "Data & infrastructure";

const CONTEXT_CATEGORY_ORDER: ContextCategory[] = [
  "Observability",
  "Code & deployment",
  "Communication & workflow",
  "Data & infrastructure",
];

const CONTEXT_CATEGORY_DESCRIPTIONS: Record<ContextCategory, string> = {
  Observability: "Errors, logs, traces, and service health",
  "Code & deployment": "Source code, releases, and runtime changes",
  "Communication & workflow": "Team conversations and incident follow-up",
  "Data & infrastructure": "Cloud resources, databases, and custom tools",
};

const CONTEXT_PROVIDER_METADATA: Record<
  IntegrationSummary["id"],
  { category: ContextCategory; searchTerms: string }
> = {
  sentry: { category: "Observability", searchTerms: "errors exceptions monitoring" },
  datadog: { category: "Observability", searchTerms: "apm logs monitors" },
  axiom: { category: "Observability", searchTerms: "logs traces metrics monitors" },
  clickstack: { category: "Observability", searchTerms: "hyperdx logs traces" },
  langfuse: { category: "Observability", searchTerms: "llm traces prompts projects" },
  github: { category: "Code & deployment", searchTerms: "repositories code pull requests" },
  vercel: { category: "Code & deployment", searchTerms: "deployments projects hosting" },
  slack: { category: "Communication & workflow", searchTerms: "channels messages chat" },
  linear: { category: "Communication & workflow", searchTerms: "issues projects tickets" },
  aws: { category: "Data & infrastructure", searchTerms: "cloud accounts iam services" },
  upstash: { category: "Data & infrastructure", searchTerms: "redis vector qstash workflow" },
  custom_mcp: { category: "Data & infrastructure", searchTerms: "custom tools server mcp" },
};

const MULTI_ACCOUNT_CONTEXT_PROVIDERS = new Set<IntegrationSummary["id"]>([
  "aws",
  "custom_mcp",
  "langfuse",
]);

const EMPTY_OPTIONS: AgentOptions = {
  accounts: [],
  resources: [],
  repositories: [],
  secrets: [],
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
const NEW_AGENT_STEPS: Array<{
  id: CreateStep;
  title: string;
  description: string;
}> = [
  { id: 1, title: "Connect Slack", description: "Workspace access" },
  { id: 2, title: "Choose channel", description: "Alert source" },
  { id: 3, title: "Agent context", description: "Tools and repositories" },
];
const EDIT_AGENT_STEPS: Array<{
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

function saveDraftToSessionStorage(
  key: string,
  draft: CreateDraft,
  options: AgentOptions,
): void {
  const persistedDraft = draftForSessionStorage(draft, options);
  window.sessionStorage.setItem(key, JSON.stringify(persistedDraft));
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
    workspaceSecretRecordIds: configuration.secretIds,
    createLinearTickets: configuration.createLinearTickets,
    linearIssueTemplate: configuration.linearIssueTemplate,
    instructions: configuration.instructions,
  };
}

function createInitialDraft(
  options: AgentOptions,
  saved: SavedCreateDraft,
  configuration: AgentConfiguration | null,
  isEditing: boolean,
): CreateDraft {
  const configured = draftFromConfiguration(options, configuration);
  const defaultContext = defaultAgentContext(options);
  const sentryAccounts = accountsFor(options, "sentry");
  const sentryProjects = resourcesOfKind(options, "sentry_project");
  const slackChannels = resourcesOfKind(options, "slack_channel");
  const vercelProjects = resourcesOfKind(options, "vercel_project");
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
    (isEditing ? defaultContext.repositoryIds : []);
  const configuredPrMode = saved.prMode ?? configured.prMode;
  const workspaceSecretRecordIds = workspaceSecretRecordIdsForDraft(
    options,
    saved,
    configured,
  );

  return {
    inputKind: isEditing
      ? saved.inputKind ?? configured.inputKind ?? "slack_channel"
      : "slack_channel",
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
    outputMode: isEditing
      ? saved.outputMode ?? configured.outputMode ?? "thread"
      : "thread",
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
      (isEditing ? defaultContext.contextAccountIds : []),
    contextResourceIds:
      saved.contextResourceIds?.filter((id) =>
        vercelProjects.some((resource) => resource.id === id),
      ) ??
      configured.contextResourceIds?.filter((id) =>
        vercelProjects.some((resource) => resource.id === id),
      ) ??
      (isEditing ? defaultContext.contextResourceIds : []),
    workspaceSecretRecordIds,
    createLinearTickets:
      saved.createLinearTickets ?? configured.createLinearTickets ?? false,
    linearIssueTemplate:
      saved.linearIssueTemplate ??
      configured.linearIssueTemplate ??
      defaultLinearIssueTemplate,
    instructions:
      isEditing
        ? saved.instructions ?? configured.instructions ?? DEFAULT_INSTRUCTIONS
        : DEFAULT_INSTRUCTIONS,
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

  const name = providerDisplayName(provider);
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
  const sentryJustConnected = successfulConnectionReturn("sentry");
  const slackJustConnected = successfulConnectionReturn("slack");
  const githubJustConnected = successfulConnectionReturn("github");
  const datadogJustConnected = successfulConnectionReturn("datadog");
  const axiomJustConnected = successfulConnectionReturn("axiom");
  const upstashJustConnected = successfulConnectionReturn("upstash");
  const langfuseJustConnected = successfulConnectionReturn("langfuse");
  const customMcpJustConnected = successfulConnectionReturn("custom_mcp");
  const clickStackJustConnected = successfulConnectionReturn("clickstack");
  const linearJustConnected = successfulConnectionReturn("linear");
  const vercelJustConnected = successfulConnectionReturn("vercel");
  const awsJustConnected = successfulConnectionReturn("aws");
  const returnedIntegrationAccountId = new URLSearchParams(
    window.location.search,
  ).get("integration_account_id");
  const contextIntegrationJustConnected =
    sentryJustConnected ||
    githubJustConnected ||
    datadogJustConnected ||
    axiomJustConnected ||
    upstashJustConnected ||
    langfuseJustConnected ||
    vercelJustConnected ||
    customMcpJustConnected ||
    clickStackJustConnected ||
    linearJustConnected ||
    awsJustConnected;
  const [options, setOptions] = useState<AgentOptions>(EMPTY_OPTIONS);
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [existingConfiguration, setExistingConfiguration] =
    useState<AgentConfiguration | null>(null);
  const [draft, setDraft] = useState<CreateDraft | null>(null);
  const initialStep = !isEditing && slackJustConnected
    ? 2
    : contextIntegrationJustConnected
      ? 3
      : readSavedStep(stepStorageKey);
  const normalizedInitialStep = !isEditing && initialStep === 4
    ? 3
    : initialStep;
  const [activeStep, setActiveStep] =
    useState<CreateStep>(normalizedInitialStep);
  // Editing an existing agent unlocks every section immediately; only the
  // create flow walks steps sequentially.
  const [furthestStep, setFurthestStep] = useState<CreateStep>(
    isEditing ? 4 : normalizedInitialStep,
  );
  const [githubDialogOpen, setGithubDialogOpen] = useState(githubJustConnected);
  const [vercelDialogOpen, setVercelDialogOpen] = useState(vercelJustConnected);
  const [vercelAccountId, setVercelAccountId] = useState(
    returnedIntegrationAccountId ?? "",
  );
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [linearDialogOpen, setLinearDialogOpen] = useState(linearJustConnected);
  const [linearAccountId, setLinearAccountId] = useState(
    linearJustConnected ? returnedIntegrationAccountId ?? "" : "",
  );
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [integrationQuery, setIntegrationQuery] = useState("");
  const [connectionSettingsOpen, setConnectionSettingsOpen] = useState<
    AgentOptions["accounts"][number] | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connectingProvider, setConnectingProvider] =
    useState<IntegrationSummary["id"] | null>(null);
  const [choosingDatadogSite, setChoosingDatadogSite] = useState(false);
  const [configuringCustomMcp, setConfiguringCustomMcp] = useState(false);
  const [connectingUpstash, setConnectingUpstash] = useState(false);
  const [connectingLangfuse, setConnectingLangfuse] = useState(false);
  const [connectingClickStack, setConnectingClickStack] = useState(false);
  const [connectingAws, setConnectingAws] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshingGithubRepositories, setRefreshingGithubRepositories] =
    useState(false);
  const [githubRefreshError, setGithubRefreshError] = useState<string | null>(
    null,
  );
  const [refreshingSlackChannels, setRefreshingSlackChannels] = useState(false);
  const [slackRefreshError, setSlackRefreshError] = useState<string | null>(null);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretHosts, setSecretHosts] = useState("");
  const [creatingSecret, setCreatingSecret] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const githubRefreshInFlight = useRef<Promise<void> | null>(null);
  const slackRefreshInFlight = useRef<Promise<void> | null>(null);
  const connectingProviderRef = useRef<IntegrationSummary["id"] | null>(null);
  const [notice] = useState(connectionNotice);
  useDocumentTitle(isEditing ? "Edit agent" : "Create agent");

  const refreshGithubRepositories = useCallback((): Promise<void> => {
    if (githubRefreshInFlight.current) return githubRefreshInFlight.current;

    setRefreshingGithubRepositories(true);
    setGithubRefreshError(null);
    const refresh = refreshGitHubAgentOptions()
      .then((freshOptions) => {
        const freshRepositoryIds = new Set(
          freshOptions.repositories.map((repository) => repository.id),
        );
        setOptions(freshOptions);
        setDraft((current) => {
          if (!current) return current;
          const repositoryIds = current.repositoryIds.filter((id) =>
            freshRepositoryIds.has(id),
          );
          return {
            ...current,
            repositoryIds,
            prMode: repositoryIds.length === 0 ? "disabled" : current.prMode,
          };
        });
      })
      .catch((caught: unknown) => {
        setGithubRefreshError(
          caught instanceof Error
            ? caught.message
            : "Unable to refresh GitHub repositories",
        );
      })
      .finally(() => {
        setRefreshingGithubRepositories(false);
        if (githubRefreshInFlight.current === refresh) {
          githubRefreshInFlight.current = null;
        }
      });
    githubRefreshInFlight.current = refresh;
    return refresh;
  }, []);

  useEffect(() => {
    if (
      !githubDialogOpen &&
      !linearDialogOpen &&
      !vercelDialogOpen &&
      !connectionSettingsOpen &&
      !secretDialogOpen
    ) {
      return;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setGithubDialogOpen(false);
        setLinearDialogOpen(false);
        setVercelDialogOpen(false);
        setConnectionSettingsOpen(null);
        if (!creatingSecret) {
          setSecretDialogOpen(false);
          setSecretName("");
          setSecretValue("");
          setSecretHosts("");
          setSecretError(null);
        }
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [
    creatingSecret,
    connectionSettingsOpen,
    githubDialogOpen,
    linearDialogOpen,
    secretDialogOpen,
    vercelDialogOpen,
  ]);

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
        if (!isEditing && !slackJustConnected && resourcesOfKind(loadedOptions, "slack_channel").length > 0) {
          setActiveStep((current) => (current === 1 ? 2 : current));
          setFurthestStep((current) => Math.max(current, 2) as CreateStep);
        }
        const loadedDraft = createInitialDraft(
          loadedOptions,
          readSavedDraft(draftStorageKey),
          loadedConfiguration,
          isEditing,
        );
        const connectedSentry = accountsFor(loadedOptions, "sentry")[0];
        if (
          sentryJustConnected &&
          connectedSentry &&
          !loadedDraft.contextAccountIds.includes(connectedSentry.id)
        ) {
          loadedDraft.contextAccountIds.push(connectedSentry.id);
        }
        const connectedGithubRepository = loadedOptions.repositories.find(
          (repository) =>
            !returnedIntegrationAccountId ||
            repository.integrationAccountId === returnedIntegrationAccountId,
        );
        if (
          githubJustConnected &&
          connectedGithubRepository &&
          loadedDraft.repositoryIds.length === 0
        ) {
          loadedDraft.repositoryIds.push(connectedGithubRepository.id);
          loadedDraft.prMode = "manual";
        }
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
        const connectedAxiom = accountsFor(loadedOptions, "axiom")[0];
        if (
          axiomJustConnected &&
          connectedAxiom &&
          !loadedDraft.contextAccountIds.includes(connectedAxiom.id)
        ) {
          loadedDraft.contextAccountIds.push(connectedAxiom.id);
        }
        const connectedCustomMcpId = returnedIntegrationAccountId;
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
        const connectedUpstashId = new URLSearchParams(
          window.location.search,
        ).get("integration_account_id");
        if (
          upstashJustConnected &&
          connectedUpstashId &&
          loadedOptions.accounts.some(
            (account) =>
              account.id === connectedUpstashId &&
              account.provider === "upstash",
          ) &&
          !loadedDraft.contextAccountIds.includes(connectedUpstashId)
        ) {
          loadedDraft.contextAccountIds.push(connectedUpstashId);
        }
        if (
          langfuseJustConnected &&
          returnedIntegrationAccountId &&
          loadedOptions.accounts.some(
            (account) =>
              account.id === returnedIntegrationAccountId &&
              account.provider === "langfuse",
          ) &&
          !loadedDraft.contextAccountIds.includes(returnedIntegrationAccountId)
        ) {
          loadedDraft.contextAccountIds.push(returnedIntegrationAccountId);
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
        const connectedLinear = accountsFor(loadedOptions, "linear")[0];
        if (
          linearJustConnected &&
          connectedLinear &&
          !loadedDraft.contextAccountIds.includes(connectedLinear.id)
        ) {
          loadedDraft.contextAccountIds.push(connectedLinear.id);
        }
        if (
          vercelJustConnected &&
          returnedIntegrationAccountId &&
          loadedOptions.accounts.some(
            (account) =>
              account.id === returnedIntegrationAccountId &&
              account.provider === "vercel",
          )
        ) {
          const firstConnectedProject = resourcesOfKind(
            loadedOptions,
            "vercel_project",
          ).find(
            (project) =>
              project.integrationAccountId === returnedIntegrationAccountId,
          );
          if (
            firstConnectedProject &&
            !loadedDraft.contextResourceIds.includes(firstConnectedProject.id)
          ) {
            loadedDraft.contextResourceIds.push(firstConnectedProject.id);
            if (
              !loadedDraft.contextAccountIds.includes(returnedIntegrationAccountId)
            ) {
              loadedDraft.contextAccountIds.push(returnedIntegrationAccountId);
            }
          }
          setVercelAccountId(returnedIntegrationAccountId);
          setVercelDialogOpen(true);
        }
        const connectedAwsId = returnedIntegrationAccountId;
        if (
          awsJustConnected &&
          connectedAwsId &&
          loadedOptions.accounts.some(
            (account) => account.id === connectedAwsId && account.provider === "aws",
          ) &&
          !loadedDraft.contextAccountIds.includes(connectedAwsId)
        ) {
          loadedDraft.contextAccountIds.push(connectedAwsId);
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
    axiomJustConnected,
    awsJustConnected,
    clickStackJustConnected,
    customMcpJustConnected,
    datadogJustConnected,
    draftStorageKey,
    githubJustConnected,
    isEditing,
    upstashJustConnected,
    langfuseJustConnected,
    linearJustConnected,
    returnedIntegrationAccountId,
    sentryJustConnected,
    slackJustConnected,
    vercelJustConnected,
  ]);

  useEffect(() => {
    if (!draft) return;
    saveDraftToSessionStorage(draftStorageKey, draft, options);
  }, [draft, draftStorageKey, options]);

  useEffect(() => {
    if (!githubJustConnected || loading) return;
    void refreshGithubRepositories();
  }, [githubJustConnected, loading, refreshGithubRepositories]);

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
  const awsAccounts = useMemo(
    () => accountsFor(options, "aws"),
    [options],
  );
  const datadogAccounts = useMemo(
    () => accountsFor(options, "datadog"),
    [options],
  );
  const axiomAccounts = useMemo(
    () => accountsFor(options, "axiom"),
    [options],
  );
  const customMcpAccounts = useMemo(
    () => accountsFor(options, "custom_mcp"),
    [options],
  );
  const upstashAccounts = useMemo(
    () => accountsFor(options, "upstash"),
    [options],
  );
  const langfuseAccounts = useMemo(
    () => accountsFor(options, "langfuse"),
    [options],
  );
  const clickStackAccounts = useMemo(
    () => accountsFor(options, "clickstack"),
    [options],
  );
  const linearAccounts = useMemo(
    () => accountsFor(options, "linear"),
    [options],
  );
  const vercelAccounts = useMemo(
    () => accountsFor(options, "vercel"),
    [options],
  );
  const githubAccounts = useMemo(
    () => accountsFor(options, "github"),
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
  const vercelProjects = useMemo(
    () => resourcesOfKind(options, "vercel_project"),
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
  const slackConnected = slackChannels.length > 0;
  const steps = isEditing ? EDIT_AGENT_STEPS : NEW_AGENT_STEPS;
  const finalStep: CreateStep = isEditing ? 4 : 3;
  const effectiveOutputMode: OutputMode = !isEditing
    ? "thread"
    : draft.inputKind === "slack_channel"
      ? draft.outputMode
      : "output_channel";
  const activeSentryAccount =
    sentryAccounts.find((account) => account.id === draft.sentryAccountId) ??
    sentryAccounts[0];
  const activeGithubAccount =
    githubAccounts.find((account) => account.id === draft.githubAccountId) ??
    githubAccounts[0];
  const activeLinearAccount =
    linearAccounts.find((account) => account.id === linearAccountId) ??
    linearAccounts[0];
  const selectedVercelProjects = vercelProjects.filter((project) =>
    draft.contextResourceIds.includes(project.id),
  );
  const activeVercelAccount =
    vercelAccounts.find((account) => account.id === vercelAccountId) ??
    vercelAccounts.find((account) =>
      selectedVercelProjects.some(
        (project) => project.integrationAccountId === account.id,
      ),
    ) ??
    vercelAccounts[0];
  const activeVercelProjects = vercelProjects.filter(
    (project) =>
      project.integrationAccountId === activeVercelAccount?.id,
  );
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
  const selectedLinearContext = options.accounts.some(
    (account) =>
      account.provider === "linear" &&
      draft.contextAccountIds.includes(account.id),
  );
  const contextRequirement =
    draft.prMode !== "disabled" && draft.repositoryIds.length === 0
      ? "Choose at least one repository for pull request fixes."
      : draft.createLinearTickets && !selectedLinearContext
        ? "Add a Linear connection to create tickets."
      : draft.createLinearTickets && !draft.linearIssueTemplate.trim()
        ? "Add a Linear issue description template."
      : null;
  const slackConnectionRequirement = !isEditing && !slackConnected
    ? "Connect Slack to continue."
    : null;
  const stepRequirements: Record<CreateStep, string | null> = isEditing
    ? {
        1: inputRequirement,
        2: outputRequirement,
        3: contextRequirement,
        4: promptRequirement,
      }
    : {
        1: slackConnectionRequirement,
        2: inputRequirement,
        3: contextRequirement,
        4: null,
      };
  const currentRequirement = stepRequirements[activeStep];
  const missingRequirement = isEditing
    ? inputRequirement ?? outputRequirement ?? contextRequirement ?? promptRequirement
    : slackConnectionRequirement ?? inputRequirement ?? contextRequirement;

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

  function openGithubDialog() {
    setGithubDialogOpen(true);
    void refreshGithubRepositories();
  }

  function integrationFor(provider: IntegrationSummary["id"]) {
    return integrations.find((integration) => integration.id === provider);
  }

  function connect(provider: IntegrationSummary["id"]) {
    if (connectingProviderRef.current) return;

    const integration = integrationFor(provider);
    const connectionUrl = integration?.state === "connected"
      ? integration.configurationUrl ?? integration.connectUrl
      : integration?.connectUrl;
    if (!integration || !connectionUrl) {
      setError(
        integration?.state === "coming_soon"
          ? `${integration.name} connection support is coming soon.`
          : `${integration?.name ?? provider} is not configured for this deployment.`,
      );
      return;
    }
    if (
      provider === "aws" ||
      provider === "datadog" ||
      provider === "clickstack" ||
      provider === "upstash" ||
      provider === "langfuse"
    ) {
      saveDraftToSessionStorage(draftStorageKey, currentDraft, options);
      if (provider === "aws") setConnectingAws(true);
      else if (provider === "datadog") setChoosingDatadogSite(true);
      else if (provider === "clickstack") setConnectingClickStack(true);
      else if (provider === "langfuse") setConnectingLangfuse(true);
      else setConnectingUpstash(true);
      return;
    }
    if (provider === "custom_mcp") {
      saveDraftToSessionStorage(draftStorageKey, currentDraft, options);
      setConfiguringCustomMcp(true);
      return;
    }
    connectingProviderRef.current = provider;
    setConnectingProvider(provider);
    saveDraftToSessionStorage(draftStorageKey, currentDraft, options);
    const separator = connectionUrl.includes("?") ? "&" : "?";
    const params = new URLSearchParams({ returnTo });
    window.location.assign(`${connectionUrl}${separator}${params}`);
  }

  function toggleContextAccount(accountId: string) {
    const removing = currentDraft.contextAccountIds.includes(accountId);
    const isLinear = options.accounts.some(
      (account) => account.id === accountId && account.provider === "linear",
    );
    updateDraft({
      contextAccountIds: removing
        ? currentDraft.contextAccountIds.filter((id) => id !== accountId)
        : [...currentDraft.contextAccountIds, accountId],
      ...(removing && isLinear ? { createLinearTickets: false } : {}),
    });
  }

  function toggleVercelProject(resourceId: string) {
    const resource = vercelProjects.find(
      (project) => project.id === resourceId,
    );
    if (!resource) return;

    const selected = currentDraft.contextResourceIds.includes(resourceId);
    const contextResourceIds = selected
      ? currentDraft.contextResourceIds.filter((id) => id !== resourceId)
      : [...currentDraft.contextResourceIds, resourceId];
    const selectedAccountIds = new Set(
      vercelProjects
        .filter((project) => contextResourceIds.includes(project.id))
        .map((project) => project.integrationAccountId),
    );

    updateDraft({
      contextResourceIds,
      contextAccountIds: [
        ...currentDraft.contextAccountIds.filter(
          (id) =>
            !vercelAccounts.some((account) => account.id === id) ||
            selectedAccountIds.has(id),
        ),
        ...[...selectedAccountIds].filter(
          (id) => !currentDraft.contextAccountIds.includes(id),
        ),
      ],
    });
  }

  function toggleGithubContextIntegration() {
    if (currentDraft.repositoryIds.length > 0) {
      updateDraft({ repositoryIds: [], prMode: "disabled" });
      return;
    }
    const firstRepository = options.repositories[0];
    if (!firstRepository) {
      openGithubDialog();
      return;
    }
    updateDraft({ repositoryIds: [firstRepository.id], prMode: "manual" });
  }

  function toggleVercelContextIntegration() {
    const selectedVercelIds = new Set(
      vercelProjects
        .filter((project) => currentDraft.contextResourceIds.includes(project.id))
        .map((project) => project.id),
    );
    if (selectedVercelIds.size > 0) {
      const vercelAccountIds = new Set(vercelAccounts.map((account) => account.id));
      updateDraft({
        contextAccountIds: currentDraft.contextAccountIds.filter(
          (id) => !vercelAccountIds.has(id),
        ),
        contextResourceIds: currentDraft.contextResourceIds.filter(
          (id) => !selectedVercelIds.has(id),
        ),
      });
      return;
    }

    const firstProject = vercelProjects[0];
    if (!firstProject) {
      setVercelDialogOpen(true);
      return;
    }
    setVercelAccountId(firstProject.integrationAccountId);
    updateDraft({
      contextAccountIds: currentDraft.contextAccountIds.includes(
        firstProject.integrationAccountId,
      )
        ? currentDraft.contextAccountIds
        : [...currentDraft.contextAccountIds, firstProject.integrationAccountId],
      contextResourceIds: [...currentDraft.contextResourceIds, firstProject.id],
    });
  }

  function toggleSecret(secretId: string) {
    updateDraft({
      workspaceSecretRecordIds:
        currentDraft.workspaceSecretRecordIds.includes(secretId)
          ? currentDraft.workspaceSecretRecordIds.filter(
              (id) => id !== secretId,
            )
          : [...currentDraft.workspaceSecretRecordIds, secretId],
    });
  }

  function closeSecretDialog() {
    if (creatingSecret) return;
    setSecretDialogOpen(false);
    setSecretName("");
    setSecretValue("");
    setSecretHosts("");
    setSecretError(null);
  }

  async function storeSecret() {
    const allowedHosts = [
      ...new Set(
        secretHosts
          .split(/[\s,]+/u)
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (!secretName.trim() || !secretValue || allowedHosts.length === 0) {
      setSecretError("Add a name, value, and at least one allowed host.");
      return;
    }

    setCreatingSecret(true);
    setSecretError(null);
    try {
      const secret = await createWorkspaceSecret({
        name: secretName.trim().toUpperCase(),
        value: secretValue,
        allowedHosts,
      });
      setOptions((current) => ({
        ...current,
        secrets: [...current.secrets, secret].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      }));
      setDraft((current) =>
        current
          ? {
              ...current,
              workspaceSecretRecordIds:
                current.workspaceSecretRecordIds.includes(secret.id)
                  ? current.workspaceSecretRecordIds
                  : [...current.workspaceSecretRecordIds, secret.id],
            }
          : current,
      );
      setSecretName("");
      setSecretValue("");
      setSecretHosts("");
      setSecretDialogOpen(false);
    } catch (caught) {
      setSecretError(
        caught instanceof Error ? caught.message : "Unable to store secret",
      );
    } finally {
      setCreatingSecret(false);
    }
  }

  function showStep(step: CreateStep) {
    if (step > furthestStep) return;
    setActiveStep(step);
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function continueToNextStep() {
    if (currentRequirement) {
      setError(currentRequirement);
      return;
    }
    if (activeStep === finalStep) return;
    const nextStep = (activeStep + 1) as CreateStep;
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

  async function saveConfiguration() {
    // Editing saves the whole configuration from any section.
    if (!isEditing && activeStep !== finalStep) return;
    if (missingRequirement) {
      setError(missingRequirement);
      const blockedStep: CreateStep = slackConnectionRequirement
        ? 1
        : inputRequirement
          ? isEditing
            ? 1
            : 2
          : outputRequirement
            ? 2
            : contextRequirement
              ? 3
              : finalStep;
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
      contextAccountIds: currentDraft.contextAccountIds,
      contextResourceIds: currentDraft.contextResourceIds,
      secretIds: currentDraft.workspaceSecretRecordIds,
      createLinearTickets: currentDraft.createLinearTickets,
      linearIssueTemplate: currentDraft.linearIssueTemplate.trim(),
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // New-agent creation is click-only. This form guard prevents implicit
    // submits from context inputs from ever creating an agent.
    if (!isEditing) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (
      !(submitter instanceof HTMLButtonElement) ||
      submitter.dataset.submitAgent !== "true"
    ) {
      return;
    }
    void saveConfiguration();
  }

  const sentryConnected = sentryProjects.length > 0;
  const outputChannelSelected = effectiveOutputMode === "output_channel";
  const vercelContextConnected = selectedVercelProjects.length > 0;
  const selectedWorkspaceSecrets = options.secrets.filter((secret) =>
    draft.workspaceSecretRecordIds.includes(secret.id),
  );
  const connectedContextCount =
    Number(draft.repositoryIds.length > 0) +
    sentryAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length +
    datadogAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length +
    axiomAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length +
    upstashAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length +
    langfuseAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length +
    Number(vercelContextConnected) +
    customMcpAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length +
    awsAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length +
    clickStackAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length +
    linearAccounts.filter((account) =>
      draft.contextAccountIds.includes(account.id),
    ).length;
  const normalizedIntegrationQuery = integrationQuery.trim().toLocaleLowerCase();
  const visibleContextIntegrations = integrations.filter((integration) => {
    if (integration.id === "slack") return false;
    if (
      integration.accountCount > 0 &&
      !MULTI_ACCOUNT_CONTEXT_PROVIDERS.has(integration.id)
    ) {
      return false;
    }
    const metadata = CONTEXT_PROVIDER_METADATA[integration.id];
    return `${integration.name} ${integration.description} ${metadata.category} ${metadata.searchTerms}`
      .toLocaleLowerCase()
      .includes(normalizedIntegrationQuery);
  });

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
      <UpstashConnectionDialog
        connectUrl={integrationFor("upstash")?.connectUrl ?? ""}
        onCancel={() => setConnectingUpstash(false)}
        open={connectingUpstash}
        returnTo={returnTo}
      />
      <LangfuseConnectionDialog
        connectUrl={integrationFor("langfuse")?.connectUrl ?? ""}
        onCancel={() => setConnectingLangfuse(false)}
        open={connectingLangfuse}
        returnTo={returnTo}
      />
      <ClickStackConnectionDialog
        connectUrl={integrationFor("clickstack")?.connectUrl ?? ""}
        onCancel={() => setConnectingClickStack(false)}
        open={connectingClickStack}
        returnTo={returnTo}
      />
      <AwsConnectionDialog
        connectUrl={integrationFor("aws")?.connectUrl ?? ""}
        onCancel={() => setConnectingAws(false)}
        open={connectingAws}
        returnTo={returnTo}
      />
      <section className="createAgentHeading">
        <div>
          <h1>{isEditing ? `Edit ${existingConfiguration?.name ?? "agent"}` : "Create agent"}</h1>
          <p>
            {isEditing
              ? "Update what starts the agent, where its results go, and what context it can use."
              : "Connect Slack, choose an alert channel, and add the context the agent can use."}
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

      <form
        className="createAgentForm createStepper"
        onKeyDown={(event) => {
          // Inputs inside the context step must not implicitly activate the
          // final submit button when Enter is pressed.
          if (
            event.key === "Enter" &&
            !(event.target instanceof HTMLButtonElement) &&
            !(event.target instanceof HTMLTextAreaElement)
          ) {
            event.preventDefault();
          }
        }}
        onSubmit={submit}
      >
        <nav
          aria-label="Agent setup progress"
          className={`createStepperRail ${
            isEditing ? "" : "createStepperRail--three"
          }`}
        >
          {steps.map((step) => {
            const current = activeStep === step.id;
            // Editing has no step order: each marker reflects whether its
            // section is complete right now.
            const complete = isEditing
              ? !stepRequirements[step.id]
              : step.id < furthestStep && !stepRequirements[step.id];
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
                  {complete ? "✓" : isEditing ? "" : step.id}
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
            !isEditing ? (
              <NewAgentSetupStep
                className="newAgentSetupStep--connect"
                description={
                  <>
                    Link the workspace where your monitoring tools post alerts.
                    <br />
                    You can choose the exact channel next.
                  </>
                }
                title="Connect Slack"
              >
                {slackConnected ? (
                  <SlackConnectionSummary
                    displayName={
                      options.accounts.find(
                        (account) =>
                          account.id ===
                          selectedSlackInput?.integrationAccountId,
                      )?.displayName ?? "Slack"
                    }
                    onReconnect={() => connect("slack")}
                  />
                ) : (
                  <div className="newAgentSetupStep__connectAction">
                    <Button
                      className="newAgentSetupStep__connectButton"
                      disabled={
                        integrationFor("slack")?.state === "coming_soon" ||
                        connectingProvider === "slack"
                      }
                      loading={connectingProvider === "slack"}
                      onClick={() => connect("slack")}
                      variant="primary"
                    >
                      {connectingProvider === "slack"
                        ? "Connecting…"
                        : integrationFor("slack")?.state === "coming_soon"
                          ? "Coming soon"
                          : "Connect Slack"}
                    </Button>
                  </div>
                )}
              </NewAgentSetupStep>
            ) : (
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
                <SlackConnectionSummary
                  displayName={
                    options.accounts.find(
                      (account) =>
                        account.id === selectedSlackInput?.integrationAccountId,
                    )?.displayName ?? "Slack"
                  }
                  onReconnect={() => connect("slack")}
                />
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
              flat
              integration={integrationFor("slack")}
              isConnecting={connectingProvider === "slack"}
              onConnect={() => connect("slack")}
              provider="slack"
              title="Connect Slack to continue"
            />
          )}
            </CreateSection>
            )
          ) : null}

          {activeStep === 2 ? (
            !isEditing ? (
              <NewAgentSetupStep
                className="newAgentSetupStep--channel"
                description="Responder starts an investigation whenever an alert appears here."
                title="Pick the alert channel"
              >
                <ChannelPicker
                  channels={slackChannels}
                  label="Alert channel"
                  onChange={(value) =>
                    updateDraft({ slackInputResourceId: value })
                  }
                  onOpen={refreshSlackChannels}
                  placeholder="Select a channel…"
                  refreshError={slackRefreshError}
                  refreshing={refreshingSlackChannels}
                  value={draft.slackInputResourceId}
                />
              </NewAgentSetupStep>
            ) : (
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
                {isEditing ? (
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
                ) : null}
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

          {isEditing && outputChannelSelected && slackConnected ? (
            <SeverityFilter draft={draft} updateDraft={updateDraft} />
          ) : null}
            </CreateSection>
            )
          ) : null}

          {activeStep === 3 ? (
            <CreateSection
              description="Choose the integrations and resources this agent can use."
              title="Agent context"
            >
              <div className="contextPanel">
                <div className="contextToolbar">
                  <span className="configurationDialog__copy">
                    <strong>Connected integrations</strong>
                    <small>
                      The agent can inspect {connectedContextCount}{" "}
                      {connectedContextCount === 1 ? "source" : "sources"}.
                    </small>
                  </span>
                </div>

                <div className="contextList">
                  {options.accounts.length === 0 ? (
                    <div className="contextIntegrationsEmpty">
                      No integrations connected yet. Add one below.
                    </div>
                  ) : null}
                  {sentryAccounts.map((account) => {
                    const enabled = draft.contextAccountIds.includes(account.id);
                    const label = sentryAccounts.length > 1 ? account.displayName : "Sentry";
                    return (
                      <ContextRow
                        action={
                          <ContextIntegrationControls
                            enabled={enabled}
                            label={label}
                            onConfigure={() => setConnectionSettingsOpen(account)}
                            onToggle={() => toggleContextAccount(account.id)}
                          />
                        }
                        detail={`${account.displayName} · Issues, events, and traces`}
                        key={account.id}
                        label={label}
                        provider="sentry"
                      />
                    );
                  })}

                  {githubAccounts.length > 0 ? (
                    <ContextRow
                    action={
                      <ContextIntegrationControls
                        enabled={draft.repositoryIds.length > 0}
                        label="GitHub"
                        onConfigure={openGithubDialog}
                        onToggle={toggleGithubContextIntegration}
                      />
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
                  />
                  ) : null}

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
                              <span className="configurationDialog__copy">
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
                                {refreshingGithubRepositories ? (
                                  <p>Refreshing repositories…</p>
                                ) : null}
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

                          {!refreshingGithubRepositories && githubRefreshError ? (
                            <Alert
                              role="alert"
                              title={`${githubRefreshError}. Showing the last available list.`}
                              tone="danger"
                            />
                          ) : null}

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

                  {awsAccounts.map((account) => {
                    const connected = draft.contextAccountIds.includes(account.id);
                    return (
                      <ContextRow
                        action={
                          <ContextIntegrationControls
                            enabled={connected}
                            label={account.displayName}
                            onConfigure={() => setConnectionSettingsOpen(account)}
                            onToggle={() => toggleContextAccount(account.id)}
                          />
                        }
                        detail="Infrastructure, telemetry, configuration, and service health"
                        key={account.id}
                        label={account.displayName}
                        provider="aws"
                      />
                    );
                  })}
                  {upstashAccounts.map((account) => {
                    const connected = draft.contextAccountIds.includes(account.id);
                    const label = upstashAccounts.length > 1 ? account.displayName : "Upstash";
                    return (
                      <ContextRow
                        action={
                          <ContextIntegrationControls
                            enabled={connected}
                            label={label}
                            onConfigure={() => setConnectionSettingsOpen(account)}
                            onToggle={() => toggleContextAccount(account.id)}
                          />
                        }
                        detail={`${account.displayName} · Redis, Vector, Search, QStash, and Workflow`}
                        key={account.id}
                        label={label}
                        provider="upstash"
                      />
                    );
                  })}

                  {langfuseAccounts.map((account) => {
                    const connected = draft.contextAccountIds.includes(account.id);
                    return (
                      <ContextRow
                        action={
                          <ContextIntegrationControls
                            enabled={connected}
                            label={account.displayName}
                            onConfigure={() => setConnectionSettingsOpen(account)}
                            onToggle={() => toggleContextAccount(account.id)}
                          />
                        }
                        detail="Traces, observations, scores, metrics, prompts, and alerts"
                        key={account.id}
                        label={account.displayName}
                        provider="langfuse"
                      />
                    );
                  })}

                  {vercelAccounts.length > 0 ? (
                    <ContextRow
                    action={
                      <ContextIntegrationControls
                        enabled={vercelContextConnected}
                        label="Vercel"
                        onConfigure={() => {
                          if (!vercelAccountId && activeVercelAccount) {
                            setVercelAccountId(activeVercelAccount.id);
                          }
                          setVercelDialogOpen(true);
                        }}
                        onToggle={toggleVercelContextIntegration}
                      />
                    }
                    detail={
                      selectedVercelProjects.length > 0
                        ? `${selectedVercelProjects.length} ${
                            selectedVercelProjects.length === 1
                              ? "project"
                              : "projects"
                          } selected · Deployments, domains, and logs`
                        : vercelAccounts.length > 0
                          ? "Choose which projects the agent may inspect"
                        : "Read-only projects, deployments, domains, and logs"
                    }
                    label="Vercel"
                    provider="vercel"
                  />
                  ) : null}

                  {vercelDialogOpen && vercelAccounts.length > 0 ? (
                    <div
                      className="configurationDialogBackdrop"
                      onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                          setVercelDialogOpen(false);
                        }
                      }}
                    >
                      <section
                        aria-labelledby="vercel-context-configuration-title"
                        aria-modal="true"
                        className="configurationDialog"
                        role="dialog"
                      >
                        <header className="configurationDialog__header">
                          <ProviderMark provider="vercel" />
                          <span className="configurationDialog__copy">
                            <strong id="vercel-context-configuration-title">
                              Configure Vercel context
                            </strong>
                            <small>
                              Choose only the projects this agent may inspect.
                            </small>
                          </span>
                          <IconButton
                            aria-label="Close Vercel context configuration"
                            autoFocus
                            onClick={() => setVercelDialogOpen(false)}
                            size="small"
                            variant="ghost"
                          >
                            ×
                          </IconButton>
                        </header>
                        <div className="configurationDialog__body">
                          {vercelAccounts.length > 1 ? (
                            <SelectField
                              className="createField createField--account"
                              label="Vercel account"
                              onChange={setVercelAccountId}
                              options={vercelAccounts.map((account) => ({
                                label: account.displayName,
                                value: account.id,
                              }))}
                              value={activeVercelAccount?.id ?? ""}
                            />
                          ) : null}
                          <div className="projectPicker">
                            <span>Projects</span>
                            <div>
                              {activeVercelProjects.length > 0 ? (
                                activeVercelProjects.map((project) => (
                                  <Checkbox
                                    checked={draft.contextResourceIds.includes(
                                      project.id,
                                    )}
                                    key={project.id}
                                    label={project.displayName}
                                    onChange={() =>
                                      toggleVercelProject(project.id)
                                    }
                                  />
                                ))
                              ) : (
                                <p className="workspaceSecretsEmpty">
                                  No projects are available for this account.
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                        <footer className="configurationDialog__footer">
                          <span>{selectedVercelProjects.length} selected</span>
                          <Button
                            onClick={() => setVercelDialogOpen(false)}
                            size="small"
                            variant="primary"
                          >
                            Done
                          </Button>
                        </footer>
                      </section>
                    </div>
                  ) : null}

                  {datadogAccounts.map((account) => {
                    const connected = draft.contextAccountIds.includes(account.id);
                    const label = datadogAccounts.length > 1 ? account.displayName : "Datadog";
                    return (
                      <ContextRow
                        action={
                          <ContextIntegrationControls
                            enabled={connected}
                            label={label}
                            onConfigure={() => setConnectionSettingsOpen(account)}
                            onToggle={() => toggleContextAccount(account.id)}
                          />
                        }
                        detail={`${account.displayName} · Logs, traces, monitors, and service health`}
                        key={account.id}
                        label={label}
                        provider="datadog"
                      />
                    );
                  })}
                  {axiomAccounts.map((account) => {
                    const connected = draft.contextAccountIds.includes(account.id);
                    const label = axiomAccounts.length > 1 ? account.displayName : "Axiom";
                    return (
                      <ContextRow
                        action={
                          <ContextIntegrationControls
                            enabled={connected}
                            label={label}
                            onConfigure={() => setConnectionSettingsOpen(account)}
                            onToggle={() => toggleContextAccount(account.id)}
                          />
                        }
                        detail={`${account.displayName} · Logs, traces, metrics, and monitor history`}
                        key={account.id}
                        label={label}
                        provider="axiom"
                      />
                    );
                  })}
                  {linearAccounts.map((account) => {
                    const connected = draft.contextAccountIds.includes(account.id);
                    const label = linearAccounts.length > 1 ? account.displayName : "Linear";
                    return (
                      <ContextRow
                        action={
                          <ContextIntegrationControls
                            enabled={connected}
                            label={label}
                            onConfigure={() => {
                              setLinearAccountId(account.id);
                              setLinearDialogOpen(true);
                            }}
                            onToggle={() => toggleContextAccount(account.id)}
                          />
                        }
                        detail={`${account.displayName} · Projects and issues · ${
                          draft.createLinearTickets
                            ? "Automatic ticket creation"
                            : "Context only"
                        }`}
                        key={account.id}
                        label={label}
                        provider="linear"
                      />
                    );
                  })}

                  {linearDialogOpen && activeLinearAccount ? (
                    <div
                      className="configurationDialogBackdrop"
                      onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                          setLinearDialogOpen(false);
                        }
                      }}
                    >
                      <section
                        aria-labelledby="linear-configuration-title"
                        aria-modal="true"
                        className="configurationDialog"
                        role="dialog"
                      >
                        <header className="configurationDialog__header">
                          <ProviderMark provider="linear" />
                          <span className="configurationDialog__copy">
                            <strong id="linear-configuration-title">
                              Configure Linear
                            </strong>
                            <small>
                              Control ticket creation and the issue description.
                            </small>
                          </span>
                          <IconButton
                            aria-label="Close Linear configuration"
                            onClick={() => setLinearDialogOpen(false)}
                            size="small"
                            variant="ghost"
                          >
                            ×
                          </IconButton>
                        </header>
                        <div className="configurationDialog__body">
                          <Checkbox
                            checked={draft.createLinearTickets}
                            description="After saving the Responder issue, let the agent choose the best Linear project and create a matching ticket."
                            label="Create Linear tickets for issues"
                            onChange={(event) =>
                              updateDraft({
                                createLinearTickets: event.target.checked,
                              })
                            }
                          />
                          <TextAreaField
                            disabled={!draft.createLinearTickets}
                            hint="Available placeholders: {{issue_id}}, {{issue_url}}, {{title}}, {{description}}, {{severity}}, {{evidence}}, {{remediation}}"
                            label="Linear issue description template"
                            maxLength={10_000}
                            onChange={(event) =>
                              updateDraft({
                                linearIssueTemplate: event.target.value,
                              })
                            }
                            rows={10}
                            value={draft.linearIssueTemplate}
                          />
                        </div>
                        <footer className="configurationDialog__footer">
                          <span>{activeLinearAccount.displayName}</span>
                          <Button
                            onClick={() => setLinearDialogOpen(false)}
                            size="small"
                            variant="primary"
                          >
                            Done
                          </Button>
                        </footer>
                      </section>
                    </div>
                  ) : null}
                  {customMcpAccounts.map((account) => {
                    const connected = draft.contextAccountIds.includes(account.id);
                    return (
                      <ContextRow
                        action={
                          <ContextIntegrationControls
                            enabled={connected}
                            label={account.displayName}
                            onConfigure={() => setConnectionSettingsOpen(account)}
                            onToggle={() => toggleContextAccount(account.id)}
                          />
                        }
                        detail="Remote tools exposed by this MCP server"
                        key={account.id}
                        label={account.displayName}
                        provider="custom_mcp"
                      />
                    );
                  })}
                  {clickStackAccounts.map((account) => {
                    const connected = draft.contextAccountIds.includes(account.id);
                    const label = clickStackAccounts.length > 1
                      ? account.displayName
                      : "ClickStack / HyperDX";
                    return (
                      <ContextRow
                        action={
                          <ContextIntegrationControls
                            enabled={connected}
                            label={label}
                            onConfigure={() => setConnectionSettingsOpen(account)}
                            onToggle={() => toggleContextAccount(account.id)}
                          />
                        }
                        detail={`${account.displayName} · Logs, traces, metrics, and service health`}
                        key={account.id}
                        label={label}
                        provider="clickstack"
                      />
                    );
                  })}
                </div>

                <section
                  aria-labelledby="add-context-integration-title"
                  className="contextIntegrationCatalog"
                >
                  <header className="contextIntegrationCatalog__header">
                    <span className="configurationDialog__copy">
                      <strong id="add-context-integration-title">Add integration</strong>
                      <small>Browse by category or search by the context you need.</small>
                    </span>
                    <label className="contextIntegrationSearch">
                      <SearchIcon />
                      <span className="srOnly">Search integrations</span>
                      <input
                        onChange={(event) => setIntegrationQuery(event.target.value)}
                        placeholder="Search integrations…"
                        type="search"
                        value={integrationQuery}
                      />
                      {integrationQuery ? (
                        <button
                          aria-label="Clear integration search"
                          onClick={() => setIntegrationQuery("")}
                          type="button"
                        >
                          ×
                        </button>
                      ) : null}
                    </label>
                  </header>

                  {visibleContextIntegrations.length > 0 ? (
                    <div className="contextIntegrationCategories">
                      {CONTEXT_CATEGORY_ORDER.map((category) => {
                        const categoryIntegrations = visibleContextIntegrations.filter(
                          (integration) =>
                            CONTEXT_PROVIDER_METADATA[integration.id].category === category,
                        );
                        if (categoryIntegrations.length === 0) return null;
                        return (
                          <section className="contextIntegrationCategory" key={category}>
                            <header>
                              <strong>{category}</strong>
                              <small>{CONTEXT_CATEGORY_DESCRIPTIONS[category]}</small>
                            </header>
                            <div className="contextIntegrationGrid">
                              {categoryIntegrations.map((integration) => {
                                const adding = connectingProvider === integration.id;
                                const unavailable =
                                  integration.state === "coming_soon" ||
                                  integration.state === "setup_required";
                                return (
                                  <article className="contextIntegrationCard" key={integration.id}>
                                    <ProviderMark provider={integration.id} />
                                    <span className="contextIntegrationCard__copy">
                                      <strong>{integration.name}</strong>
                                      <small>{integration.description}</small>
                                    </span>
                                    <footer>
                                      <Button
                                        disabled={unavailable}
                                        loading={adding}
                                        onClick={() => connect(integration.id)}
                                        size="small"
                                        type="button"
                                        variant="primary"
                                      >
                                        {integration.state === "coming_soon"
                                          ? "Coming soon"
                                          : integration.state === "setup_required"
                                            ? "Setup required"
                                            : "Add"}
                                      </Button>
                                    </footer>
                                  </article>
                                );
                              })}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="contextIntegrationsEmpty">
                      No integrations match “{integrationQuery}”.
                    </div>
                  )}
                </section>
              </div>

              {connectionSettingsOpen ? (
                <div
                  className="configurationDialogBackdrop"
                  onMouseDown={(event) => {
                    if (event.target === event.currentTarget) {
                      setConnectionSettingsOpen(null);
                    }
                  }}
                >
                  <section
                    aria-labelledby="context-connection-settings-title"
                    aria-modal="true"
                    className="configurationDialog"
                    role="dialog"
                  >
                    <header className="configurationDialog__header">
                      <ProviderMark provider={connectionSettingsOpen.provider} />
                      <span className="configurationDialog__copy">
                        <strong id="context-connection-settings-title">
                          Configure {connectionSettingsOpen.displayName}
                        </strong>
                        <small>
                          {providerDisplayName(connectionSettingsOpen.provider)} connection
                        </small>
                      </span>
                      <IconButton
                        aria-label="Close integration configuration"
                        onClick={() => setConnectionSettingsOpen(null)}
                        size="small"
                        type="button"
                        variant="ghost"
                      >
                        ×
                      </IconButton>
                    </header>
                    <div className="configurationDialog__body">
                      <div className="contextConnectionSummary">
                        <span>Connected account</span>
                        <strong>{connectionSettingsOpen.displayName}</strong>
                        <small>
                          This integration is enabled as a whole. Manage credentials and
                          provider access from integration settings.
                        </small>
                      </div>
                    </div>
                    <footer className="configurationDialog__footer">
                      <Button
                        onClick={() => navigate("/settings")}
                        size="small"
                        type="button"
                        variant="secondary"
                      >
                        Manage integration
                      </Button>
                      <Button
                        onClick={() => setConnectionSettingsOpen(null)}
                        size="small"
                        type="button"
                        variant="primary"
                      >
                        Done
                      </Button>
                    </footer>
                  </section>
                </div>
              ) : null}

              <div className="workspaceSecretsPanel">
                <div className="contextToolbar">
                  <span className="configurationDialog__copy">
                    <strong>Workspace secrets</strong>
                    <small>
                      Selected secrets are exposed as opaque environment
                      variables and only resolve for allowed hosts.
                    </small>
                  </span>
                  <Button
                    onClick={() => setSecretDialogOpen(true)}
                    size="small"
                    type="button"
                    variant="secondary"
                  >
                    Add secret
                  </Button>
                </div>

                {selectedWorkspaceSecrets.length > 0 ? (
                  <div className="workspaceSelectedSecretList">
                    {selectedWorkspaceSecrets.map((secret) => (
                      <div className="workspaceSelectedSecret" key={secret.id}>
                        <span className="configurationDialog__copy">
                          <strong>{secret.name}</strong>
                          <small>
                            Allowed for {secret.allowedHosts.join(", ")}
                          </small>
                        </span>
                        <Button
                          onClick={() => toggleSecret(secret.id)}
                          size="small"
                          type="button"
                          variant="ghost"
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="workspaceSecretsEmpty">
                    No secrets added to this agent.
                  </div>
                )}

                {secretDialogOpen ? (
                  <div
                    className="configurationDialogBackdrop"
                    onMouseDown={(event) => {
                      if (event.target === event.currentTarget) {
                        closeSecretDialog();
                      }
                    }}
                  >
                    <section
                      aria-labelledby="workspace-secret-dialog-title"
                      aria-modal="true"
                      className="configurationDialog workspaceSecretDialog"
                      role="dialog"
                    >
                      <header className="configurationDialog__header">
                        <div
                          aria-hidden="true"
                          className="workspaceSecretDialogIcon"
                        >
                          •••
                        </div>
                        <span className="configurationDialog__copy">
                          <strong id="workspace-secret-dialog-title">
                            Add a workspace secret
                          </strong>
                          <small>
                            Select an existing secret or create a write-only one.
                          </small>
                        </span>
                        <IconButton
                          aria-label="Close workspace secret dialog"
                          disabled={creatingSecret}
                          onClick={closeSecretDialog}
                          size="small"
                          variant="ghost"
                        >
                          ×
                        </IconButton>
                      </header>
                      <div className="configurationDialog__body">
                        <div className="workspaceSecretDialogSection">
                          <span className="workspaceSecretDialogSection__title">
                            Existing workspace secrets
                          </span>
                          {options.secrets.length > 0 ? (
                            <div className="workspaceSecretList">
                              {options.secrets.map((secret) => (
                                <Checkbox
                                  checked={draft.workspaceSecretRecordIds.includes(
                                    secret.id,
                                  )}
                                  description={`Allowed for ${secret.allowedHosts.join(", ")}`}
                                  key={secret.id}
                                  label={secret.name}
                                  onChange={() => toggleSecret(secret.id)}
                                />
                              ))}
                            </div>
                          ) : (
                            <p className="workspaceSecretsEmpty">
                              This workspace does not have any secrets yet.
                            </p>
                          )}
                        </div>

                        <div className="workspaceSecretDialogSection">
                          <span className="workspaceSecretDialogSection__title">
                            Create a new secret
                          </span>
                          <div className="workspaceSecretForm">
                            <label className="createField">
                              <span>Environment variable</span>
                              <input
                                autoComplete="off"
                                autoFocus
                                onChange={(event) =>
                                  setSecretName(event.target.value.toUpperCase())
                                }
                                placeholder="SERVICE_API_KEY"
                                value={secretName}
                              />
                            </label>
                            <label className="createField">
                              <span>Secret value</span>
                              <input
                                autoComplete="new-password"
                                onChange={(event) =>
                                  setSecretValue(event.target.value)
                                }
                                placeholder="Stored once and never shown again"
                                type="password"
                                value={secretValue}
                              />
                            </label>
                            <label className="createField workspaceSecretHosts">
                              <span>Allowed hosts</span>
                              <input
                                autoComplete="off"
                                onChange={(event) =>
                                  setSecretHosts(event.target.value)
                                }
                                placeholder="api.example.com, *.example.net"
                                value={secretHosts}
                              />
                            </label>
                            <Button
                              disabled={creatingSecret}
                              loading={creatingSecret}
                              onClick={() => void storeSecret()}
                              type="button"
                              variant="secondary"
                            >
                              Store and add
                            </Button>
                          </div>
                          {secretError ? (
                            <p className="workspaceSecretError" role="alert">
                              {secretError}
                            </p>
                          ) : null}
                          <p className="workspaceSecretHint">
                            The value cannot be viewed after storage. Rotate it by
                            creating a replacement secret.
                          </p>
                        </div>
                      </div>
                      <footer className="configurationDialog__footer">
                        <span>
                          {selectedWorkspaceSecrets.length} selected
                        </span>
                        <Button
                          disabled={creatingSecret}
                          onClick={closeSecretDialog}
                          size="small"
                          variant="primary"
                        >
                          Done
                        </Button>
                      </footer>
                    </section>
                  </div>
                ) : null}
              </div>
            </CreateSection>
          ) : null}

          {isEditing && activeStep === 4 ? (
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

          {!isEditing && activeStep === 1 && !slackConnected ? null : (
          <footer
            className={`createAgentActions ${
              !isEditing && activeStep === 2
                ? "createAgentActions--guided"
                : ""
            }`}
          >
            {(isEditing || activeStep >= 3) &&
            (currentRequirement || activeStep >= 3) ? (
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
            {!isEditing && activeStep < finalStep ? (
              <Button
                disabled={Boolean(currentRequirement)}
                onClick={continueToNextStep}
                type="button"
                variant="primary"
              >
                {activeStep === 2 ? "Continue to context" : "Continue"}
              </Button>
            ) : null}
            {isEditing || activeStep === finalStep ? (
              <Button
                data-submit-agent="true"
                disabled={Boolean(missingRequirement) || saving}
                loading={saving}
                onClick={!isEditing ? () => void saveConfiguration() : undefined}
                type={isEditing ? "submit" : "button"}
                variant="primary"
              >
                {isEditing ? "Save changes" : "Create agent"}
              </Button>
            ) : null}
          </footer>
          )}
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

function NewAgentSetupStep({
  children,
  className,
  description,
  title,
}: {
  children: ReactNode;
  className: string;
  description: ReactNode;
  title: string;
}) {
  return (
    <section className={`newAgentSetupStep ${className}`}>
      <header>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
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

function SlackConnectionSummary({
  displayName,
  onReconnect,
}: {
  displayName: string;
  onReconnect: () => void;
}) {
  return (
    <div className="slackConnectionHeader">
      <div className="slackConnectionIdentity">
        <ProviderMark provider="slack" />
        <div className="connectedAccount">
          <span>Slack workspace</span>
          <strong>{displayName}</strong>
        </div>
      </div>
      <Button
        className="slackReconnectButton"
        onClick={onReconnect}
        size="small"
        variant="secondary"
      >
        Reconnect
      </Button>
    </div>
  );
}
function ConnectionPrompt({
  actionLabel,
  compact = false,
  flat = false,
  integration,
  isConnecting,
  onConnect,
  provider,
  title,
}: {
  actionLabel: string;
  compact?: boolean;
  flat?: boolean;
  integration: IntegrationSummary | undefined;
  isConnecting: boolean;
  onConnect: () => void;
  provider: "slack" | "sentry";
  title: string;
}) {
  const comingSoon = integration?.state === "coming_soon";
  return (
    <div
      className={`connectionPrompt ${compact ? "isCompact" : ""} ${flat ? "isFlat" : ""}`}
    >
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
  placeholder = "Choose a channel",
  refreshError,
  refreshing = false,
  value,
}: {
  channels: AgentOptions["resources"];
  label: string;
  onChange: (value: string) => void;
  onOpen?: () => void | Promise<void>;
  placeholder?: string;
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
        <span className={selected ? undefined : "channelPicker__placeholder"}>
          {selected
            ? slackChannelLabel(selected.displayName)
            : placeholder}
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
