import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  fetchAgentOptions,
  fetchIntegrations,
  type AgentOptions,
  type IntegrationSummary,
} from "../agents-api";
import {
  fetchScans,
  saveScanConfiguration,
  startScan as startScanRequest,
  type ScanConfiguration,
} from "../scans-api";
import {
  AgentContextIntegrationControls,
  AgentContextProviderMark,
  AgentContextRow,
} from "../components/agent-context-controls";
import { AppShell } from "../components/app-shell";
import { ArrowIcon, SearchIcon, SignalIcon } from "../components/icons";
import type { ProviderGlyphId } from "../components/provider-glyphs";
import {
  contextCategoryDescriptions,
  contextCategoryOrder,
  contextProviderMetadata,
} from "../components/provider-glyphs";
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  IconButton,
  SelectField,
} from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import { scanRuns, type ScanRun } from "./scan-data";

type ScanSource = {
  accountId?: string;
  connectionName?: string;
  connected: boolean;
  description: string;
  enabled: boolean;
  id: string;
  kind: "account" | "github" | "vercel";
  name: string;
  provider: Exclude<ProviderGlyphId, "google" | "scan">;
  resourceLabel: string;
  resources: Array<{
    description: string;
    id: string;
    label: string;
    selected: boolean;
  }>;
};

const initialSources: ScanSource[] = [
  {
    id: "sentry",
    kind: "account",
    connected: true,
    description: "Errors, releases, and affected services",
    enabled: true,
    name: "Sentry",
    provider: "sentry",
    resourceLabel: "projects",
    resources: [
      { description: "Production", id: "sentry-web", label: "responder-web", selected: true },
      { description: "Production", id: "sentry-worker", label: "responder-worker", selected: true },
    ],
  },
  {
    id: "datadog",
    kind: "account",
    connected: true,
    description: "Logs, traces, monitors, and service health",
    enabled: true,
    name: "Datadog",
    provider: "datadog",
    resourceLabel: "services",
    resources: [
      { description: "Production", id: "datadog-api", label: "responder-api", selected: true },
      { description: "Production", id: "datadog-worker", label: "responder-worker", selected: true },
    ],
  },
  {
    id: "github",
    kind: "github",
    connected: true,
    description: "Repositories, changes, and deployments",
    enabled: true,
    name: "GitHub",
    provider: "github",
    resourceLabel: "repositories",
    resources: [
      { description: "superloglabs", id: "github-responder", label: "responder", selected: true },
      { description: "superloglabs", id: "github-oss", label: "responder-oss", selected: true },
      { description: "superloglabs", id: "github-infra", label: "infrastructure", selected: true },
    ],
  },
  {
    id: "aws",
    kind: "account",
    connected: true,
    description: "Infrastructure and runtime context",
    enabled: false,
    name: "AWS",
    provider: "aws",
    resourceLabel: "accounts",
    resources: [
      { description: "121638211609", id: "aws-production", label: "Production", selected: true },
    ],
  },
  {
    id: "posthog",
    kind: "account",
    connected: false,
    description: "Product analytics, errors, and session replay",
    enabled: false,
    name: "PostHog",
    provider: "posthog",
    resourceLabel: "projects",
    resources: [],
  },
  {
    id: "axiom",
    kind: "account",
    connected: false,
    description: "Application logs and traces",
    enabled: false,
    name: "Axiom",
    provider: "axiom",
    resourceLabel: "datasets",
    resources: [],
  },
  {
    id: "dash0",
    kind: "account",
    connected: false,
    description: "Logs, metrics, traces, checks, and dashboards",
    enabled: false,
    name: "Dash0",
    provider: "dash0",
    resourceLabel: "organizations",
    resources: [],
  },
  {
    id: "clickstack",
    kind: "account",
    connected: false,
    description: "Logs, traces, metrics, and service health",
    enabled: false,
    name: "ClickStack / HyperDX",
    provider: "clickstack",
    resourceLabel: "connections",
    resources: [],
  },
  {
    id: "langfuse",
    kind: "account",
    connected: false,
    description: "LLM traces, observations, scores, and prompts",
    enabled: false,
    name: "Langfuse",
    provider: "langfuse",
    resourceLabel: "projects",
    resources: [],
  },
  {
    id: "vercel",
    kind: "vercel",
    connected: false,
    description: "Deployments, domains, and runtime logs",
    enabled: false,
    name: "Vercel",
    provider: "vercel",
    resourceLabel: "projects",
    resources: [],
  },
  {
    id: "linear",
    kind: "account",
    connected: false,
    description: "Projects and issues for operational context",
    enabled: false,
    name: "Linear",
    provider: "linear",
    resourceLabel: "projects",
    resources: [],
  },
  {
    id: "gcp",
    kind: "account",
    connected: false,
    description: "Asset inventory, logs, metrics, and alerts",
    enabled: false,
    name: "Google Cloud",
    provider: "gcp",
    resourceLabel: "projects",
    resources: [],
  },
  {
    id: "upstash",
    kind: "account",
    connected: false,
    description: "Redis, Vector, Search, QStash, and Workflow",
    enabled: false,
    name: "Upstash",
    provider: "upstash",
    resourceLabel: "databases",
    resources: [],
  },
  {
    id: "supabase",
    kind: "account",
    connected: false,
    description: "Project logs and scoped PostgreSQL access",
    enabled: false,
    name: "Supabase",
    provider: "supabase",
    resourceLabel: "projects",
    resources: [],
  },
  {
    id: "custom_mcp",
    kind: "account",
    connected: false,
    description: "Remote tools exposed by an MCP server",
    enabled: false,
    name: "Custom MCP",
    provider: "custom_mcp",
    resourceLabel: "servers",
    resources: [],
  },
];

const dialogFocusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const sourceTemplateByProvider = new Map(
  initialSources.map((source) => [source.provider, source]),
);

function configuredSources(
  options: AgentOptions,
  configuration: ScanConfiguration,
): ScanSource[] {
  const accountSources = options.accounts
    .filter(
      (account) =>
        account.provider !== "slack" &&
        account.provider !== "github" &&
        account.provider !== "vercel" &&
        account.provider !== "custom_mcp",
    )
    .map((account): ScanSource => {
      const template = sourceTemplateByProvider.get(account.provider);
      return {
        accountId: account.id,
        connectionName: account.displayName,
        connected: true,
        description: template?.description ?? account.displayName,
        enabled: configuration.contextAccountIds.includes(account.id),
        id: account.id,
        kind: "account",
        name: options.accounts.filter(
          (candidate) => candidate.provider === account.provider,
        ).length > 1
          ? account.displayName
          : template?.name ?? account.displayName,
        provider: account.provider,
        resourceLabel: "account",
        resources: [],
      };
    });
  const githubAccounts = options.accounts.filter(
    (account) => account.provider === "github",
  );
  const githubSource: ScanSource[] = githubAccounts.length > 0
    ? [{
        ...sourceTemplateByProvider.get("github")!,
        connected: true,
        enabled: configuration.repositoryIds.length > 0,
        id: "github",
        kind: "github",
        resources: options.repositories.map((repository) => ({
          description: `${repository.private ? "Private" : "Public"} · ${repository.defaultBranch}`,
          id: repository.id,
          label: repository.fullName,
          selected: configuration.repositoryIds.includes(repository.id),
        })),
      }]
    : [];
  const vercelAccounts = options.accounts.filter(
    (account) => account.provider === "vercel",
  );
  const vercelProjects = options.resources.filter(
    (resource) => resource.kind === "vercel_project",
  );
  const vercelSource: ScanSource[] = vercelAccounts.length > 0
    ? [{
        ...sourceTemplateByProvider.get("vercel")!,
        connected: true,
        enabled: vercelProjects.some((project) =>
          configuration.contextResourceIds.includes(project.id),
        ),
        id: "vercel",
        kind: "vercel",
        resources: vercelProjects.map((project) => ({
          description:
            vercelAccounts.find((account) => account.id === project.integrationAccountId)
              ?.displayName ?? "Connected account",
          id: project.id,
          label: project.displayName,
          selected: configuration.contextResourceIds.includes(project.id),
        })),
      }]
    : [];
  const connectedProviders = new Set(
    [...accountSources, ...githubSource, ...vercelSource].map(
      (source) => source.provider,
    ),
  );
  const unavailableSources = initialSources
    .filter(
      (source) =>
        source.provider !== "slack" &&
        source.provider !== "custom_mcp" &&
        !connectedProviders.has(source.provider),
    )
    .map((source) => ({ ...source, connected: false, enabled: false }));
  return [...accountSources, ...githubSource, ...vercelSource, ...unavailableSources];
}

function configurationWithSources(
  configuration: ScanConfiguration,
  sources: ScanSource[],
  options: AgentOptions | null,
): ScanConfiguration {
  const visibleAccountIds = new Set(
    sources.flatMap((source) => source.accountId ? [source.accountId] : []),
  );
  const hiddenConnectedAccountIds = new Set(
    (options?.accounts ?? [])
      .filter((account) => account.provider === "custom_mcp")
      .map((account) => account.id),
  );
  const preservedAccountIds = configuration.contextAccountIds.filter(
    (accountId) =>
      !visibleAccountIds.has(accountId) &&
      hiddenConnectedAccountIds.has(accountId),
  );
  const contextAccountIds = sources.flatMap((source) =>
    source.kind === "account" && source.enabled && source.accountId
      ? [source.accountId]
      : [],
  );
  const repositoryIds = sources
    .filter((source) => source.kind === "github")
    .flatMap((source) => source.resources.filter((resource) => resource.selected).map((resource) => resource.id));
  const contextResourceIds = sources
    .filter((source) => source.kind === "vercel")
    .flatMap((source) => source.resources.filter((resource) => resource.selected).map((resource) => resource.id));
  const vercelAccountIds = new Set(
    (options?.resources ?? [])
      .filter((resource) => contextResourceIds.includes(resource.id))
      .map((resource) => resource.integrationAccountId),
  );
  return {
    ...configuration,
    contextAccountIds: [
      ...new Set([
        ...preservedAccountIds,
        ...contextAccountIds,
        ...vercelAccountIds,
      ]),
    ],
    contextResourceIds,
    repositoryIds,
  };
}

export function ScansPage() {
  useDocumentTitle("Scans");
  const { pathname } = useLocation();
  const isStoryboard = pathname.startsWith("/_storyboards");
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLElement>(null);
  const initialConfiguration: ScanConfiguration = {
    frequencyHours: isStoryboard ? 6 : null,
    slackChannelResourceId: isStoryboard ? "incidents" : null,
    contextAccountIds: [],
    contextResourceIds: [],
    repositoryIds: [],
  };
  const configurationRef = useRef<ScanConfiguration>(initialConfiguration);
  const saveVersionRef = useRef(0);
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [configuration, setConfiguration] = useState(initialConfiguration);
  const [options, setOptions] = useState<AgentOptions | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [sources, setSources] = useState(isStoryboard ? initialSources : []);
  const [runs, setRuns] = useState(isStoryboard ? scanRuns : []);
  const [integrationQuery, setIntegrationQuery] = useState("");
  const [sourcesDialogOpen, setSourcesDialogOpen] = useState(false);
  const [configurationTarget, setConfigurationTarget] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isStoryboard);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isStoryboard) return;
    let cancelled = false;
    void Promise.all([fetchAgentOptions(), fetchScans()])
      .then(([loadedOptions, loadedScans]) => {
        if (cancelled) return;
        configurationRef.current = loadedScans.configuration;
        setConfiguration(loadedScans.configuration);
        setOptions(loadedOptions);
        setSources(configuredSources(loadedOptions, loadedScans.configuration));
        setRuns(loadedScans.runs);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Unable to load scans");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isStoryboard]);

  useEffect(() => {
    if (isStoryboard) return;
    let cancelled = false;
    void fetchIntegrations()
      .then((loadedIntegrations) => {
        if (!cancelled) setIntegrations(loadedIntegrations);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isStoryboard]);

  useEffect(() => {
    if (isStoryboard || !runs.some((scan) => scan.status === "running")) return;
    const timer = window.setInterval(() => {
      void fetchScans()
        .then((loaded) => setRuns(loaded.runs))
        .catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [isStoryboard, runs]);

  function persist(next: ScanConfiguration) {
    configurationRef.current = next;
    setConfiguration(next);
    if (isStoryboard) return;
    const version = ++saveVersionRef.current;
    setSaving(true);
    setError(null);
    const save = saveQueueRef.current
      .catch(() => undefined)
      .then(() => saveScanConfiguration(next))
      .finally(() => {
        if (saveVersionRef.current === version) setSaving(false);
      });
    saveQueueRef.current = save;
    void save.catch((caught: unknown) => {
        if (saveVersionRef.current !== version) return;
        setError(caught instanceof Error ? caught.message : "Unable to save scan settings");
      });
  }

  const selectedSourceCount = sources.filter(
    (source) => source.connected && source.enabled,
  ).length;
  const connectedSources = sources.filter((source) => source.connected);
  const connectedSourceNames = connectedSources.map((source) => source.name);
  const normalizedQuery = integrationQuery.trim().toLocaleLowerCase();
  const availableSources = sources.filter(
    (source) =>
      !source.connected &&
      `${source.name} ${source.description} ${contextProviderMetadata[source.provider].category} ${contextProviderMetadata[source.provider].searchTerms}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
  );
  const sourceToConfigure = sources.find(
    (source) => source.id === configurationTarget,
  );
  const slackChannelOptions = useMemo(() => {
    if (isStoryboard) {
      return [
        { label: "#incidents", value: "incidents" },
        { label: "#engineering", value: "engineering" },
        { label: "#platform-alerts", value: "platform-alerts" },
      ];
    }
    const slackAccountIds = new Set(
      options?.accounts.filter((account) => account.provider === "slack").map((account) => account.id) ?? [],
    );
    return [
      { label: "Choose a channel", value: "" },
      ...(options?.resources ?? [])
        .filter(
          (resource) =>
            resource.kind === "slack_channel" &&
            slackAccountIds.has(resource.integrationAccountId),
        )
        .map((resource) => ({
          label: resource.displayName.startsWith("#")
            ? resource.displayName
            : `#${resource.displayName}`,
          value: resource.id,
        })),
    ];
  }, [isStoryboard, options]);

  function closeSourcesDialog() {
    setSourcesDialogOpen(false);
    setConfigurationTarget(null);
    setIntegrationQuery("");
  }

  function integrationConnectionUrl(source: ScanSource): string {
    const integration = integrations.find((candidate) => candidate.id === source.provider);
    const connectionUrl = integration?.connectUrl;
    const settingsDialogProviders = new Set([
      "aws",
      "gcp",
      "datadog",
      "dash0",
      "custom_mcp",
      "upstash",
      "langfuse",
      "supabase",
      "clickstack",
    ]);
    if (!connectionUrl || settingsDialogProviders.has(source.provider)) {
      return `/settings#integration-${source.provider}`;
    }
    const url = new URL(connectionUrl, window.location.origin);
    url.searchParams.set("returnTo", "/scans");
    return `${url.pathname}${url.search}`;
  }

  useEffect(() => {
    if (!sourcesDialogOpen) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const backdrop = dialogRef.current?.parentElement;
    const appShell = backdrop?.parentElement;
    const backgroundElements = appShell
      ? Array.from(appShell.children).filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element !== backdrop,
        )
      : [];
    const priorInertStates = backgroundElements.map((element) => ({
      element,
      inert: element.inert,
    }));

    backgroundElements.forEach((element) => {
      element.inert = true;
    });

    return () => {
      priorInertStates.forEach(({ element, inert }) => {
        element.inert = inert;
      });
      previouslyFocused?.focus();
    };
  }, [sourcesDialogOpen]);

  useEffect(() => {
    if (!sourcesDialogOpen) return;

    const animationFrame = requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(dialogFocusableSelector)
        ?.focus();
    });

    return () => cancelAnimationFrame(animationFrame);
  }, [configurationTarget, sourcesDialogOpen]);

  useEffect(() => {
    if (!sourcesDialogOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (configurationTarget) {
          setConfigurationTarget(null);
          return;
        }
        setSourcesDialogOpen(false);
        setIntegrationQuery("");
        return;
      }

      if (event.key !== "Tab") return;
      const focusableElements = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          dialogFocusableSelector,
        ) ?? [],
      );
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements.at(-1);
      const activeElement = document.activeElement;
      if (
        event.shiftKey &&
        (activeElement === firstElement ||
          !dialogRef.current?.contains(activeElement))
      ) {
        event.preventDefault();
        lastElement?.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [configurationTarget, sourcesDialogOpen]);

  function updateSources(update: (current: ScanSource[]) => ScanSource[]) {
    const next = update(sources);
    setSources(next);
    persist(configurationWithSources(configurationRef.current, next, options));
  }

  function toggleSource(sourceId: string) {
    updateSources((current) =>
      current.map((source) => {
        if (source.id !== sourceId) return source;
        if (source.kind === "account") {
          return { ...source, enabled: !source.enabled };
        }
        const selected = !source.enabled;
        return {
          ...source,
          enabled: selected,
          resources: source.resources.map((resource) => ({
            ...resource,
            selected,
          })),
        };
      }),
    );
  }

  async function startScan() {
    if (runs.some((scan) => scan.status === "running")) return;
    if (isStoryboard) {
      setRuns((current) => [
        {
          activeIssues: 0,
          duration: "—",
          filedIssues: 0,
          id: "scan-running",
          sources: selectedSourceCount,
          startedAt: new Date().toISOString(),
          startedLabel: "Now",
          status: "running",
        },
        ...current,
      ]);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      await saveQueueRef.current;
      await startScanRequest();
      const loaded = await fetchScans();
      setRuns(loaded.runs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to start scan");
    } finally {
      setStarting(false);
    }
  }

  function toggleResource(sourceId: string, resourceId: string) {
    updateSources((current) =>
      current.map((source) =>
        source.id === sourceId
          ? (() => {
              const resources = source.resources.map((resource) =>
                resource.id === resourceId
                  ? { ...resource, selected: !resource.selected }
                  : resource,
              );
              return {
              ...source,
                enabled: resources.some((resource) => resource.selected),
                resources,
              };
            })()
          : source,
      ),
    );
  }

  const isRunning = starting || runs.some((scan) => scan.status === "running");
  const scanDetailPath = (scanId: string) =>
    pathname.startsWith("/_storyboards")
      ? `/_storyboards/scans/${scanId}`
      : `/scans/${scanId}`;

  return (
    <AppShell active="scans" density="scans">
      <div className="scansSetup">
        <section className="pageHeading scansHeading">
          <div>
            <h1>Scans</h1>
            <p>Find active issues across your stack before they are reported.</p>
          </div>
          <Button loading={isRunning} onClick={startScan} variant="secondary">
            {isRunning ? "Running scan…" : "Run scan now"}
          </Button>
        </section>

        <div className="scansSettings">
          <section aria-label="Scan settings" className="scanControls">
            <SelectField
              label="Frequency"
              onChange={(value) =>
                persist({
                  ...configurationRef.current,
                  frequencyHours: value === "off" ? null : value === "1" ? 1 : 6,
                })
              }
              options={[
                { label: "Off", value: "off" },
                { label: "Every hour", value: "1" },
                { label: "Every 6 hours", value: "6" },
              ]}
              value={configuration.frequencyHours?.toString() ?? "off"}
            />
            <SelectField
              label="Slack channel where we post findings"
              onChange={(value) =>
                persist({
                  ...configurationRef.current,
                  slackChannelResourceId: value || null,
                })
              }
              options={slackChannelOptions}
              value={configuration.slackChannelResourceId ?? ""}
            />
          </section>

          {error ? <p className="formError">{error}</p> : null}
          {saving ? <span className="srOnly" aria-live="polite">Saving scan settings</span> : null}

          <section aria-labelledby="scan-sources-title" className="scanSources">
            <div className="scanSourceSummary">
              <div aria-hidden="true" className="scanSourceSummary__providers">
                {connectedSources.map((source) => (
                  <AgentContextProviderMark
                    connected={source.enabled}
                    key={source.id}
                    provider={source.provider}
                  />
                ))}
              </div>
              <span className="scanSourceSummary__copy">
                <strong id="scan-sources-title">Connected integrations</strong>
                <small>
                  {connectedSources.length} connected · {selectedSourceCount} used by scans
                </small>
                <small>{connectedSourceNames.join(", ")}</small>
              </span>
              <Button
                onClick={() => setSourcesDialogOpen(true)}
                size="small"
                variant="secondary"
              >
                Configure
              </Button>
            </div>
          </section>
        </div>
      </div>

      {sourcesDialogOpen ? (
        <div
          className="configurationDialogBackdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSourcesDialog();
          }}
        >
          {sourceToConfigure ? (
            <section
              aria-labelledby="scan-source-configuration-title"
              aria-modal="true"
              className="configurationDialog scanSourcesDialog"
              ref={dialogRef}
              role="dialog"
            >
              <header className="configurationDialog__header">
                <AgentContextProviderMark provider={sourceToConfigure.provider} />
                <span className="configurationDialog__copy">
                  <strong id="scan-source-configuration-title">
                    Configure {sourceToConfigure.name}
                  </strong>
                  <small>Choose what scheduled scans can inspect.</small>
                </span>
                <IconButton
                  aria-label="Close integration configuration"
                  onClick={closeSourcesDialog}
                  size="small"
                  variant="ghost"
                >
                  ×
                </IconButton>
              </header>
              <div className="configurationDialog__body">
                <div className="contextConnectionSummary">
                  <span>Connected account</span>
                  <strong>{sourceToConfigure.connectionName ?? sourceToConfigure.name}</strong>
                  <small>{sourceToConfigure.description}</small>
                </div>
                <fieldset className="scanResourceList">
                  <legend>{sourceToConfigure.resourceLabel}</legend>
                  {sourceToConfigure.resources.map((resource) => (
                    <Checkbox
                      checked={resource.selected}
                      description={resource.description}
                      key={resource.id}
                      label={resource.label}
                      onChange={() =>
                        toggleResource(sourceToConfigure.id, resource.id)
                      }
                    />
                  ))}
                  {sourceToConfigure.resources.length === 0 ? (
                    <p>This integration is configured at the account level.</p>
                  ) : null}
                </fieldset>
              </div>
              <footer className="configurationDialog__footer">
                <span>
                  {sourceToConfigure.kind === "account"
                    ? sourceToConfigure.enabled ? "Account enabled" : "Account not used"
                    : `${sourceToConfigure.resources.filter((resource) => resource.selected).length} selected`}
                </span>
                <Button onClick={() => setConfigurationTarget(null)} size="small">
                  Done
                </Button>
              </footer>
            </section>
          ) : (
            <section
              aria-labelledby="scan-integrations-dialog-title"
              aria-modal="true"
              className="configurationDialog scanSourcesDialog"
              ref={dialogRef}
              role="dialog"
            >
              <header className="configurationDialog__header">
                <span aria-hidden="true" className="scanSourcesDialog__mark">
                  <SignalIcon />
                </span>
                <span className="configurationDialog__copy">
                  <strong id="scan-integrations-dialog-title">
                    Configure integrations
                  </strong>
                  <small>Choose the context scheduled scans can inspect.</small>
                </span>
                <IconButton
                  aria-label="Close integration configuration"
                  onClick={closeSourcesDialog}
                  size="small"
                  variant="ghost"
                >
                  ×
                </IconButton>
              </header>
              <div className="configurationDialog__body">
                <div className="contextPanel">
                  <div className="contextList">
                    {connectedSources.map((source) => {
                      const selectedResources = source.resources.filter(
                        (resource) => resource.selected,
                      ).length;
                      return (
                        <AgentContextRow
                          action={
                            <AgentContextIntegrationControls
                              enabled={source.enabled}
                              label={source.name}
                              onConfigure={() =>
                                setConfigurationTarget(source.id)
                              }
                              onToggle={() => toggleSource(source.id)}
                              toggleAriaLabel={`${source.enabled ? "Disable" : "Enable"} ${source.name} for scheduled scans`}
                            />
                          }
                          detail={source.kind === "account"
                            ? source.description
                            : `${selectedResources} ${source.resourceLabel} selected · ${source.description}`}
                          key={source.id}
                          label={source.name}
                          provider={source.provider}
                        />
                      );
                    })}
                  </div>

                  <section
                    aria-labelledby="scan-add-integration-title"
                    className="contextIntegrationCatalog"
                  >
                    <header className="contextIntegrationCatalog__header">
                      <span className="configurationDialog__copy">
                        <strong id="scan-add-integration-title">Add integration</strong>
                        <small>
                          Browse by category or search by the context you need.
                        </small>
                      </span>
                      <label className="contextIntegrationSearch">
                        <SearchIcon />
                        <span className="srOnly">Search integrations</span>
                        <input
                          onChange={(event) =>
                            setIntegrationQuery(event.target.value)
                          }
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

                    {availableSources.length > 0 ? (
                      <div className="contextIntegrationCategories">
                        {contextCategoryOrder.map((category) => {
                          const categorySources = availableSources.filter(
                            (source) =>
                              contextProviderMetadata[source.provider].category ===
                              category,
                          );
                          if (categorySources.length === 0) return null;
                          return (
                            <section
                              className="contextIntegrationCategory"
                              key={category}
                            >
                              <header>
                                <strong>{category}</strong>
                                <small>{contextCategoryDescriptions[category]}</small>
                              </header>
                              <div className="contextIntegrationGrid">
                                {categorySources.map((source) => (
                                  <article
                                    className="contextIntegrationCard"
                                    key={source.id}
                                  >
                                    <AgentContextProviderMark
                                      provider={source.provider}
                                    />
                                    <span className="contextIntegrationCard__copy">
                                      <strong>{source.name}</strong>
                                      <small>{source.description}</small>
                                    </span>
                                    <footer>
                                      <a
                                        className="dsButton dsButton--secondary dsButton--small"
                                        href={integrationConnectionUrl(source)}
                                      >
                                        Connect
                                      </a>
                                    </footer>
                                  </article>
                                ))}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="contextIntegrationsEmpty">
                        No integrations match “{integrationQuery.trim()}”. Clear the
                        search to browse all.
                      </div>
                    )}
                  </section>
                </div>
              </div>
              <footer className="configurationDialog__footer">
                <span>
                  {selectedSourceCount} {selectedSourceCount === 1 ? "source" : "sources"}{" "}
                  enabled
                </span>
                <Button onClick={closeSourcesDialog} size="small">
                  Done
                </Button>
              </footer>
            </section>
          )}
        </div>
      ) : null}

      <section aria-labelledby="recent-scans-title" className="recentScans">
        <div className="scanSectionHeading">
          <div>
            <h2 id="recent-scans-title">Recent scans</h2>
            <p>New issues are filed once. Existing issues stay linked to their first report.</p>
          </div>
        </div>
        <div className="scanHistoryTable">
          <DataTable<ScanRun>
            aria-label="Recent scans"
            columns={[
              {
                header: "Scan",
                key: "scan",
                render: (scan) => (
                  <Link
                    className="scanTableTitle"
                    to={scanDetailPath(scan.id)}
                  >
                    <time dateTime={scan.startedAt}>{scan.startedLabel}</time>
                    {scan.status === "running" ? (
                      <Badge tone="info">Running</Badge>
                    ) : scan.status === "failed" ? (
                      <Badge tone="danger">Failed</Badge>
                    ) : null}
                  </Link>
                ),
                width: "38%",
              },
              {
                header: "Findings",
                key: "findings",
                render: (scan) => (
                  <span className="scanTableFindings">
                    {scan.status === "running"
                      ? "Checking…"
                      : scan.status === "failed"
                        ? "Scan failed"
                      : `${scan.activeIssues} active · ${scan.filedIssues} new`}
                  </span>
                ),
                width: "25%",
              },
              {
                header: "Sources",
                key: "sources",
                render: (scan) => `${scan.sources} integrations`,
                width: "17%",
              },
              {
                align: "right",
                header: "Duration",
                key: "duration",
                render: (scan) => scan.duration,
                width: "15%",
              },
              {
                align: "right",
                header: "",
                key: "open",
                render: (scan) => (
                  <Link
                    aria-label={`Open scan from ${scan.startedLabel}`}
                    className="issueTableArrow"
                    to={scanDetailPath(scan.id)}
                  >
                    <ArrowIcon />
                  </Link>
                ),
                width: "5%",
              },
            ]}
            getRowKey={(scan) => scan.id}
            onRowClick={(scan) => navigate(scanDetailPath(scan.id))}
            rows={loading ? [] : runs}
          />
          {loading ? <p className="contextIntegrationsEmpty">Loading scans…</p> : null}
        </div>
      </section>
    </AppShell>
  );
}
