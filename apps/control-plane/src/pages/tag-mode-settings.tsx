import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  fetchAgentOptions,
  fetchIntegrations,
  fetchSlackThreadModeConfiguration,
  saveSlackThreadModeConfiguration,
  type AgentOptions,
  type IntegrationSummary,
  type SlackThreadModeConfiguration,
} from "../agents-api";
import { AwsConnectionDialog } from "../components/aws-connection-dialog";
import { GcpConnectionDialog } from "../components/gcp-connection-dialog";
import { ClickStackConnectionDialog } from "../components/clickstack-connection-dialog";
import { CustomMcpConnectionDialog } from "../components/custom-mcp-dialog";
import { DatadogConnectionDialog } from "../components/datadog-site-dialog";
import {
  AgentContextIntegrationControls,
  AgentContextProviderMark,
  AgentContextRow,
} from "../components/agent-context-controls";
import { AppShell } from "../components/app-shell";
import { LangfuseConnectionDialog } from "../components/langfuse-connection-dialog";
import { SupabaseConnectionDialog } from "../components/supabase-connection-dialog";
import { currentSupabaseProjectSelectionState } from "../supabase-project-selection";
import { RepositoryIcon, SearchIcon } from "../components/icons";
import { providerDisplayName } from "../components/provider-glyphs";
import { SettingsTabs } from "../components/settings-tabs";
import { UpstashConnectionDialog } from "../components/upstash-connection-dialog";
import { Button, Checkbox, IconButton, TextAreaField } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

const defaultConfiguration: SlackThreadModeConfiguration = {
  enabled: false,
  model: "instance/default",
  instructions:
    "Investigate the request using connected context and attached repositories. Report what you found, the supporting evidence, and the recommended next step.",
  repositoryIds: [],
  contextAccountIds: [],
  contextResourceIds: [],
  secretIds: [],
};

type ContextAccount = AgentOptions["accounts"][number];
type ConfigurationTarget = ContextAccount | "github" | "vercel" | "secrets";
type ContextCategory =
  | "Observability"
  | "Code & deployment"
  | "Communication & workflow"
  | "Data & infrastructure";

const tagModeDraftKey = "responder:tag-mode-settings-draft";
const contextCategoryOrder: ContextCategory[] = [
  "Observability",
  "Code & deployment",
  "Communication & workflow",
  "Data & infrastructure",
];
const contextCategoryDescriptions: Record<ContextCategory, string> = {
  Observability: "Errors, logs, traces, and service health",
  "Code & deployment": "Source code, releases, and runtime changes",
  "Communication & workflow": "Team conversations and incident follow-up",
  "Data & infrastructure": "Cloud resources, databases, and custom tools",
};
const contextProviderMetadata: Record<
  IntegrationSummary["id"],
  { category: ContextCategory; searchTerms: string }
> = {
  sentry: { category: "Observability", searchTerms: "errors exceptions monitoring" },
  datadog: { category: "Observability", searchTerms: "apm logs monitors" },
  dash0: { category: "Observability", searchTerms: "logs metrics traces checks alerts" },
  posthog: { category: "Observability", searchTerms: "analytics errors logs traces replays alerts" },
  axiom: { category: "Observability", searchTerms: "logs traces metrics monitors" },
  clickstack: { category: "Observability", searchTerms: "hyperdx logs traces" },
  langfuse: { category: "Observability", searchTerms: "llm traces prompts projects" },
  github: { category: "Code & deployment", searchTerms: "repositories code pull requests" },
  vercel: { category: "Code & deployment", searchTerms: "deployments projects hosting" },
  slack: { category: "Communication & workflow", searchTerms: "channels messages chat" },
  linear: { category: "Communication & workflow", searchTerms: "issues projects tickets" },
  aws: { category: "Data & infrastructure", searchTerms: "cloud accounts iam services" },
  gcp: { category: "Data & infrastructure", searchTerms: "google cloud projects logs metrics assets" },
  upstash: { category: "Data & infrastructure", searchTerms: "redis vector qstash workflow" },
  supabase: { category: "Data & infrastructure", searchTerms: "postgres database sql logs" },
  custom_mcp: { category: "Data & infrastructure", searchTerms: "custom tools server mcp" },
};
const multiAccountContextProviders = new Set<IntegrationSummary["id"]>([
  "aws",
  "gcp",
  "custom_mcp",
  "langfuse",
  "supabase",
  "dash0",
  "posthog",
]);

const contextProviderOrder: ContextAccount["provider"][] = [
  "sentry",
  "aws",
  "gcp",
  "upstash",
  "langfuse",
  "supabase",
  "datadog",
  "dash0",
  "posthog",
  "axiom",
  "linear",
  "custom_mcp",
  "clickstack",
];

function toggle(values: string[], value: string, checked: boolean): string[] {
  return checked
    ? [...new Set([...values, value])]
    : values.filter((candidate) => candidate !== value);
}

function accountDetail(account: ContextAccount): string {
  const prefix = `${account.displayName} · `;
  switch (account.provider) {
    case "sentry":
      return `${prefix}Issues, events, and traces`;
    case "aws":
      return "Infrastructure, telemetry, configuration, and service health";
    case "gcp":
      return "Asset inventory, logs, metrics, and alerting state";
    case "upstash":
      return `${prefix}Redis, Vector, Search, QStash, and Workflow`;
    case "langfuse":
      return "Traces, observations, scores, metrics, prompts, and alerts";
    case "supabase":
      return "Project logs and scoped PostgreSQL access";
    case "datadog":
      return `${prefix}Logs, traces, monitors, and service health`;
    case "dash0":
      return `${prefix}Logs, metrics, traces, checks, and dashboards`;
    case "posthog":
      return `${prefix}Errors, logs, traces, replays, and product analytics`;
    case "axiom":
      return `${prefix}Logs, traces, metrics, and monitor history`;
    case "linear":
      return `${prefix}Projects and issues · Context only`;
    case "custom_mcp":
      return "Remote tools exposed by this MCP server";
    case "clickstack":
      return `${prefix}Logs, traces, metrics, and service health`;
    default:
      return account.displayName;
  }
}

function accountLabel(account: ContextAccount, accounts: ContextAccount[]): string {
  const providerAccounts = accounts.filter(
    (candidate) => candidate.provider === account.provider,
  );
  if (providerAccounts.length > 1) return account.displayName;
  if (account.provider === "clickstack") return "ClickStack / HyperDX";
  return providerDisplayName(account.provider);
}

export function TagModeSettingsPage() {
  useDocumentTitle("Tag mode settings");
  const navigate = useNavigate();
  const [options, setOptions] = useState<AgentOptions | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [integrationQuery, setIntegrationQuery] = useState("");
  const [connectingProvider, setConnectingProvider] =
    useState<IntegrationSummary["id"] | null>(null);
  const [connectingAws, setConnectingAws] = useState(false);
  const [connectingGcp, setConnectingGcp] = useState(false);
  const [choosingDatadogSite, setChoosingDatadogSite] = useState(false);
  const [configuringCustomMcp, setConfiguringCustomMcp] = useState(false);
  const [connectingUpstash, setConnectingUpstash] = useState(false);
  const [connectingLangfuse, setConnectingLangfuse] = useState(false);
  const supabaseSelectionState = currentSupabaseProjectSelectionState();
  const [connectingSupabase, setConnectingSupabase] = useState(
    Boolean(supabaseSelectionState),
  );
  const [connectingClickStack, setConnectingClickStack] = useState(false);
  const [configuration, setConfiguration] =
    useState<SlackThreadModeConfiguration>(defaultConfiguration);
  const [configurationTarget, setConfigurationTarget] =
    useState<ConfigurationTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchAgentOptions(),
      fetchIntegrations(),
      fetchSlackThreadModeConfiguration(),
    ])
      .then(([loadedOptions, loadedIntegrations, loadedConfiguration]) => {
        if (cancelled) return;
        setOptions(loadedOptions);
        setIntegrations(loadedIntegrations);
        const storedDraft = window.sessionStorage.getItem(tagModeDraftKey);
        if (storedDraft) {
          window.sessionStorage.removeItem(tagModeDraftKey);
          try {
            setConfiguration(JSON.parse(storedDraft) as SlackThreadModeConfiguration);
          } catch {
            setConfiguration(loadedConfiguration ?? defaultConfiguration);
          }
        } else {
          setConfiguration(loadedConfiguration ?? defaultConfiguration);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Unable to load tag mode");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const contextAccounts = useMemo(() => {
    if (!options) return [];
    return contextProviderOrder.flatMap((provider) =>
      options.accounts.filter((account) => account.provider === provider),
    );
  }, [options]);
  const vercelAccounts = useMemo(
    () => options?.accounts.filter((account) => account.provider === "vercel") ?? [],
    [options],
  );
  const githubConnected = options?.accounts.some(
    (account) => account.provider === "github",
  ) ?? false;
  const vercelProjects = useMemo(
    () => options?.resources.filter((resource) => resource.kind === "vercel_project") ?? [],
    [options],
  );
  const selectedVercelProjects = vercelProjects.filter((project) =>
    configuration.contextResourceIds.includes(project.id),
  );
  const selectedRepositories = options?.repositories.filter((repository) =>
    configuration.repositoryIds.includes(repository.id),
  ) ?? [];
  const selectedSecrets = options?.secrets.filter((secret) =>
    configuration.secretIds.includes(secret.id),
  ) ?? [];
  const connectedContextCount =
    contextAccounts.filter((account) =>
      configuration.contextAccountIds.includes(account.id),
    ).length +
    Number(selectedRepositories.length > 0) +
    Number(selectedVercelProjects.length > 0);
  const normalizedIntegrationQuery = integrationQuery.trim().toLocaleLowerCase();
  const visibleContextIntegrations = integrations.filter((integration) => {
    if (integration.id === "slack") return false;
    if (
      integration.accountCount > 0 &&
      integration.id !== "sentry" &&
      !multiAccountContextProviders.has(integration.id)
    ) {
      return false;
    }
    const metadata = contextProviderMetadata[integration.id];
    return `${integration.name} ${integration.description} ${metadata.category} ${metadata.searchTerms}`
      .toLocaleLowerCase()
      .includes(normalizedIntegrationQuery);
  });

  function update(patch: Partial<SlackThreadModeConfiguration>) {
    setConfiguration((current) => ({ ...current, ...patch }));
    setNotice(null);
  }

  function toggleContextAccount(accountId: string) {
    update({
      contextAccountIds: toggle(
        configuration.contextAccountIds,
        accountId,
        !configuration.contextAccountIds.includes(accountId),
      ),
    });
  }

  function toggleGithubContext() {
    if (configuration.repositoryIds.length > 0) {
      update({ repositoryIds: [] });
      return;
    }
    const firstRepository = options?.repositories[0];
    if (!firstRepository) {
      setConfigurationTarget("github");
      return;
    }
    update({ repositoryIds: [firstRepository.id] });
  }

  function updateVercelSelection(contextResourceIds: string[]) {
    const selectedAccountIds = new Set(
      vercelProjects
        .filter((project) => contextResourceIds.includes(project.id))
        .map((project) => project.integrationAccountId),
    );
    const vercelAccountIds = new Set(vercelAccounts.map((account) => account.id));
    update({
      contextResourceIds,
      contextAccountIds: [
        ...configuration.contextAccountIds.filter(
          (id) => !vercelAccountIds.has(id) || selectedAccountIds.has(id),
        ),
        ...[...selectedAccountIds].filter(
          (id) => !configuration.contextAccountIds.includes(id),
        ),
      ],
    });
  }

  function toggleVercelContext() {
    if (selectedVercelProjects.length > 0) {
      updateVercelSelection(
        configuration.contextResourceIds.filter(
          (id) => !vercelProjects.some((project) => project.id === id),
        ),
      );
      return;
    }
    const firstProject = vercelProjects[0];
    if (firstProject) {
      updateVercelSelection([...configuration.contextResourceIds, firstProject.id]);
    } else if (vercelAccounts.length > 0) {
      setConfigurationTarget("vercel");
    }
  }

  function connectIntegration(integration: IntegrationSummary) {
    const connectionUrl = integration.state === "connected"
      ? integration.configurationUrl ?? integration.connectUrl
      : integration.connectUrl;
    if (!connectionUrl) {
      setError(
        integration.state === "coming_soon"
          ? `${integration.name} connection support is coming soon.`
          : `${integration.name} is not configured for this deployment.`,
      );
      return;
    }
    window.sessionStorage.setItem(tagModeDraftKey, JSON.stringify(configuration));
    if (integration.id === "aws") {
      setConnectingAws(true);
      return;
    }
    if (integration.id === "gcp") {
      setConnectingGcp(true);
      return;
    }
    if (integration.id === "datadog") {
      setChoosingDatadogSite(true);
      return;
    }
    if (integration.id === "custom_mcp") {
      setConfiguringCustomMcp(true);
      return;
    }
    if (integration.id === "upstash") {
      setConnectingUpstash(true);
      return;
    }
    if (integration.id === "langfuse") {
      setConnectingLangfuse(true);
      return;
    }
    if (integration.id === "supabase") {
      setConnectingSupabase(true);
      return;
    }
    if (integration.id === "clickstack") {
      setConnectingClickStack(true);
      return;
    }
    setConnectingProvider(integration.id);
    const url = new URL(connectionUrl, window.location.origin);
    url.searchParams.set("returnTo", "/settings/tag-mode");
    window.location.assign(`${url.pathname}${url.search}`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveSlackThreadModeConfiguration(configuration);
      setConfiguration(saved);
      setNotice("Tag mode settings saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save tag mode");
    } finally {
      setSaving(false);
    }
  }

  async function toggleTagMode() {
    const nextConfiguration = {
      ...configuration,
      enabled: !configuration.enabled,
    };
    setConfiguration(nextConfiguration);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveSlackThreadModeConfiguration(nextConfiguration);
      setConfiguration(saved);
      setNotice(`Tag mode ${saved.enabled ? "enabled" : "disabled"}.`);
    } catch (caught) {
      setConfiguration(configuration);
      setError(caught instanceof Error ? caught.message : "Unable to save tag mode");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell active="settings" density="settings">
      <DatadogConnectionDialog
        connectUrl={integrations.find((item) => item.id === "datadog")?.connectUrl ?? ""}
        onCancel={() => setChoosingDatadogSite(false)}
        open={choosingDatadogSite}
        returnTo="/settings/tag-mode"
      />
      <CustomMcpConnectionDialog
        connectUrl={integrations.find((item) => item.id === "custom_mcp")?.connectUrl ?? ""}
        onCancel={() => setConfiguringCustomMcp(false)}
        open={configuringCustomMcp}
        returnTo="/settings/tag-mode"
      />
      <UpstashConnectionDialog
        connectUrl={integrations.find((item) => item.id === "upstash")?.connectUrl ?? ""}
        onCancel={() => setConnectingUpstash(false)}
        open={connectingUpstash}
        returnTo="/settings/tag-mode"
      />
      <LangfuseConnectionDialog
        connectUrl={integrations.find((item) => item.id === "langfuse")?.connectUrl ?? ""}
        onCancel={() => setConnectingLangfuse(false)}
        open={connectingLangfuse}
        returnTo="/settings/tag-mode"
      />
      <SupabaseConnectionDialog
        connectUrl={integrations.find((item) => item.id === "supabase")?.connectUrl ?? ""}
        onCancel={() => setConnectingSupabase(false)}
        open={connectingSupabase}
        returnTo="/settings/tag-mode"
        selectionState={supabaseSelectionState}
      />
      <ClickStackConnectionDialog
        connectUrl={integrations.find((item) => item.id === "clickstack")?.connectUrl ?? ""}
        onCancel={() => setConnectingClickStack(false)}
        open={connectingClickStack}
        returnTo="/settings/tag-mode"
      />
      <AwsConnectionDialog
        connectUrl={integrations.find((item) => item.id === "aws")?.connectUrl ?? ""}
        onCancel={() => setConnectingAws(false)}
        open={connectingAws}
        returnTo="/settings/tag-mode"
      />
      <GcpConnectionDialog
        connectUrl={integrations.find((item) => item.id === "gcp")?.connectUrl ?? ""}
        onCancel={() => setConnectingGcp(false)}
        open={connectingGcp}
        returnTo="/settings/tag-mode"
      />
      <section className="settingsHeading">
        <h1>Settings</h1>
        <p>Manage your workspace, members, and connected services.</p>
      </section>
      <SettingsTabs active="tag-mode" />

      <form className="tagModeSettings" onSubmit={submit}>
        {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
        {notice ? <p className="settingsNotice settingsNotice--success">{notice}</p> : null}

        <section className="tagModeSettings__toggleSection">
          <div className="contextToolbar">
            <span className="configurationDialog__copy">
              <strong>Tag mode</strong>
              <small>Control whether Slack mentions start ad-hoc investigations.</small>
            </span>
            <AgentContextIntegrationControls
              disabled={saving || !options}
              enabled={configuration.enabled}
              label="Slack tag mode"
              onToggle={() => void toggleTagMode()}
              toggleAriaLabel={`${configuration.enabled ? "Disable" : "Enable"} Slack tag mode`}
            />
          </div>
        </section>

        <section className="contextPanel">
          <div className="contextToolbar">
            <span className="configurationDialog__copy">
              <strong>Connected integrations</strong>
              <small>
                Tag mode can inspect {connectedContextCount}{" "}
                {connectedContextCount === 1 ? "source" : "sources"}.
              </small>
            </span>
          </div>

          <div className="contextList">
            {!options ? (
              <div className="contextIntegrationsEmpty">Loading integrations…</div>
            ) : null}
            {options &&
            contextAccounts.length === 0 &&
            !githubConnected &&
            vercelAccounts.length === 0 ? (
              <div className="contextIntegrationsEmpty">
                No integrations connected yet. Add one from Integrations settings.
              </div>
            ) : null}

            {contextAccounts.map((account) => {
              const enabled = configuration.contextAccountIds.includes(account.id);
              const label = accountLabel(account, contextAccounts);
              return (
                <AgentContextRow
                  action={
                    <AgentContextIntegrationControls
                      enabled={enabled}
                      label={label}
                      onConfigure={() => setConfigurationTarget(account)}
                      onToggle={() => toggleContextAccount(account.id)}
                      toggleAriaLabel={`${enabled ? "Disable" : "Enable"} ${label} for tag mode`}
                    />
                  }
                  detail={accountDetail(account)}
                  key={account.id}
                  label={label}
                  provider={account.provider}
                />
              );
            })}

            {options && githubConnected ? (
              <AgentContextRow
                action={
                  <AgentContextIntegrationControls
                    enabled={selectedRepositories.length > 0}
                    label="GitHub"
                    onConfigure={() => setConfigurationTarget("github")}
                    onToggle={toggleGithubContext}
                    toggleAriaLabel={`${selectedRepositories.length > 0 ? "Disable" : "Enable"} GitHub for tag mode`}
                  />
                }
                detail={`${selectedRepositories.length} ${selectedRepositories.length === 1 ? "repository" : "repositories"} selected · Read-only code context`}
                label="GitHub"
                provider="github"
              />
            ) : null}

            {vercelAccounts.length > 0 ? (
              <AgentContextRow
                action={
                  <AgentContextIntegrationControls
                    enabled={selectedVercelProjects.length > 0}
                    label="Vercel"
                    onConfigure={() => setConfigurationTarget("vercel")}
                    onToggle={toggleVercelContext}
                    toggleAriaLabel={`${selectedVercelProjects.length > 0 ? "Disable" : "Enable"} Vercel for tag mode`}
                  />
                }
                detail={
                  selectedVercelProjects.length > 0
                    ? `${selectedVercelProjects.length} ${selectedVercelProjects.length === 1 ? "project" : "projects"} selected · Deployments, domains, and logs`
                    : "Choose which projects Tag mode may inspect"
                }
                label="Vercel"
                provider="vercel"
              />
            ) : null}
          </div>

          <section
            aria-labelledby="tag-mode-add-integration-title"
            className="contextIntegrationCatalog"
          >
            <header className="contextIntegrationCatalog__header">
              <span className="configurationDialog__copy">
                <strong id="tag-mode-add-integration-title">Add integration</strong>
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
                {contextCategoryOrder.map((category) => {
                  const categoryIntegrations = visibleContextIntegrations.filter(
                    (integration) =>
                      contextProviderMetadata[integration.id].category === category,
                  );
                  if (categoryIntegrations.length === 0) return null;
                  return (
                    <section className="contextIntegrationCategory" key={category}>
                      <header>
                        <strong>{category}</strong>
                        <small>{contextCategoryDescriptions[category]}</small>
                      </header>
                      <div className="contextIntegrationGrid">
                        {categoryIntegrations.map((integration) => {
                          const unavailable =
                            integration.state === "coming_soon" ||
                            integration.state === "setup_required";
                          return (
                            <article className="contextIntegrationCard" key={integration.id}>
                              <AgentContextProviderMark provider={integration.id} />
                              <span className="contextIntegrationCard__copy">
                                <strong>{integration.name}</strong>
                                <small>{integration.description}</small>
                              </span>
                              <footer>
                                <Button
                                  disabled={unavailable}
                                  loading={connectingProvider === integration.id}
                                  onClick={() => connectIntegration(integration)}
                                  size="small"
                                  type="button"
                                  variant="secondary"
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
        </section>

        <section className="workspaceSecretsPanel">
          <div className="contextToolbar">
            <span className="configurationDialog__copy">
              <strong>Workspace secrets</strong>
              <small>
                Selected secrets are exposed as opaque environment variables and only
                resolve for allowed hosts.
              </small>
            </span>
            <Button
              onClick={() => setConfigurationTarget("secrets")}
              size="small"
              type="button"
              variant="secondary"
            >
              Choose secrets
            </Button>
          </div>
          {selectedSecrets.length > 0 ? (
            <div className="workspaceSelectedSecretList">
              {selectedSecrets.map((secret) => (
                <div className="workspaceSelectedSecret" key={secret.id}>
                  <span className="configurationDialog__copy">
                    <strong>{secret.name}</strong>
                    <small>Allowed for {secret.allowedHosts.join(", ")}</small>
                  </span>
                  <Button
                    onClick={() => update({
                      secretIds: configuration.secretIds.filter((id) => id !== secret.id),
                    })}
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
            <div className="workspaceSecretsEmpty">No secrets added to Tag mode.</div>
          )}

          <section className="tagModeSettings__prompt">
            <div className="tagModeSettings__sectionHeading">
              <h2>Prompt</h2>
              <p>Tell Responder how to investigate and answer thread requests.</p>
            </div>
            <TextAreaField
              className="tagModeSettings__promptField"
              label="Agent prompt"
              maxLength={20_000}
              onChange={(event) => update({ instructions: event.target.value })}
              rows={4}
              value={configuration.instructions}
            />
          </section>
        </section>

        <div className="tagModeSettings__actions">
          <Button disabled={saving || !options} type="submit" variant="secondary">
            {saving ? "Saving…" : "Save tag mode"}
          </Button>
        </div>

        {configurationTarget === "github" && options ? (
          <div
            className="configurationDialogBackdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setConfigurationTarget(null);
            }}
          >
            <section
              aria-labelledby="tag-mode-github-title"
              aria-modal="true"
              className="configurationDialog"
              role="dialog"
            >
              <header className="configurationDialog__header">
                <AgentContextProviderMark provider="github" />
                <span className="configurationDialog__copy">
                  <strong id="tag-mode-github-title">Configure GitHub</strong>
                  <small>Choose the repositories Tag mode may inspect.</small>
                </span>
                <IconButton
                  aria-label="Close GitHub configuration"
                  onClick={() => setConfigurationTarget(null)}
                  size="small"
                  type="button"
                  variant="ghost"
                >
                  ×
                </IconButton>
              </header>
              <div className="configurationDialog__body">
                <div className="repositoryConnectList">
                  {options.repositories.map((repository) => {
                    const selected = configuration.repositoryIds.includes(repository.id);
                    return (
                      <div className="repositoryConnectRow" key={repository.id}>
                        <span className="repositoryConnectRow__icon"><RepositoryIcon /></span>
                        <span className="repositoryConnectRow__copy">
                          <strong>{repository.fullName}</strong>
                          <small>{repository.private ? "Private" : "Public"} · {repository.defaultBranch}</small>
                        </span>
                        <Button
                          aria-pressed={selected}
                          className={`repositoryConnectButton ${selected ? "isConnected" : ""}`}
                          onClick={() => update({
                            repositoryIds: toggle(
                              configuration.repositoryIds,
                              repository.id,
                              !selected,
                            ),
                          })}
                          size="small"
                          type="button"
                          variant={selected ? "secondary" : "primary"}
                        >
                          {selected ? "Selected" : "Select"}
                        </Button>
                      </div>
                    );
                  })}
                  {options.repositories.length === 0 ? (
                    <p>No repositories are available for this connection.</p>
                  ) : null}
                </div>
              </div>
              <footer className="configurationDialog__footer">
                <span>{selectedRepositories.length} selected</span>
                <Button onClick={() => setConfigurationTarget(null)} size="small" type="submit">
                  Done
                </Button>
              </footer>
            </section>
          </div>
        ) : null}

        {configurationTarget === "vercel" ? (
          <div
            className="configurationDialogBackdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setConfigurationTarget(null);
            }}
          >
            <section
              aria-labelledby="tag-mode-vercel-title"
              aria-modal="true"
              className="configurationDialog"
              role="dialog"
            >
              <header className="configurationDialog__header">
                <AgentContextProviderMark provider="vercel" />
                <span className="configurationDialog__copy">
                  <strong id="tag-mode-vercel-title">Configure Vercel context</strong>
                  <small>Choose only the projects Tag mode may inspect.</small>
                </span>
                <IconButton
                  aria-label="Close Vercel configuration"
                  onClick={() => setConfigurationTarget(null)}
                  size="small"
                  type="button"
                  variant="ghost"
                >
                  ×
                </IconButton>
              </header>
              <div className="configurationDialog__body">
                <div className="projectPicker">
                  <span>Projects</span>
                  <div>
                    {vercelProjects.map((project) => (
                      <Checkbox
                        checked={configuration.contextResourceIds.includes(project.id)}
                        key={project.id}
                        label={project.displayName}
                        onChange={() => updateVercelSelection(toggle(
                          configuration.contextResourceIds,
                          project.id,
                          !configuration.contextResourceIds.includes(project.id),
                        ))}
                      />
                    ))}
                    {vercelProjects.length === 0 ? (
                      <p className="workspaceSecretsEmpty">
                        No projects are available for this connection.
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
              <footer className="configurationDialog__footer">
                <span>{selectedVercelProjects.length} selected</span>
                <Button onClick={() => setConfigurationTarget(null)} size="small" type="submit">
                  Done
                </Button>
              </footer>
            </section>
          </div>
        ) : null}

        {configurationTarget === "secrets" && options ? (
          <div
            className="configurationDialogBackdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setConfigurationTarget(null);
            }}
          >
            <section
              aria-labelledby="tag-mode-secrets-title"
              aria-modal="true"
              className="configurationDialog workspaceSecretDialog"
              role="dialog"
            >
              <header className="configurationDialog__header">
                <div aria-hidden="true" className="workspaceSecretDialogIcon">•••</div>
                <span className="configurationDialog__copy">
                  <strong id="tag-mode-secrets-title">Choose workspace secrets</strong>
                  <small>Select the secrets Tag mode may use.</small>
                </span>
                <IconButton
                  aria-label="Close workspace secret configuration"
                  onClick={() => setConfigurationTarget(null)}
                  size="small"
                  type="button"
                  variant="ghost"
                >
                  ×
                </IconButton>
              </header>
              <div className="configurationDialog__body">
                <div className="workspaceSecretList">
                  {options.secrets.map((secret) => (
                    <Checkbox
                      checked={configuration.secretIds.includes(secret.id)}
                      description={`Allowed for ${secret.allowedHosts.join(", ")}`}
                      key={secret.id}
                      label={secret.name}
                      onChange={() => update({
                        secretIds: toggle(
                          configuration.secretIds,
                          secret.id,
                          !configuration.secretIds.includes(secret.id),
                        ),
                      })}
                    />
                  ))}
                  {options.secrets.length === 0 ? (
                    <p className="workspaceSecretsEmpty">No workspace secrets are available.</p>
                  ) : null}
                </div>
              </div>
              <footer className="configurationDialog__footer">
                <span>{selectedSecrets.length} selected</span>
                <Button onClick={() => setConfigurationTarget(null)} size="small" type="submit">
                  Done
                </Button>
              </footer>
            </section>
          </div>
        ) : null}

        {configurationTarget &&
        typeof configurationTarget === "object" ? (
          <div
            className="configurationDialogBackdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setConfigurationTarget(null);
            }}
          >
            <section
              aria-labelledby="tag-mode-integration-title"
              aria-modal="true"
              className="configurationDialog"
              role="dialog"
            >
              <header className="configurationDialog__header">
                <AgentContextProviderMark provider={configurationTarget.provider} />
                <span className="configurationDialog__copy">
                  <strong id="tag-mode-integration-title">
                    Configure {configurationTarget.displayName}
                  </strong>
                  <small>{providerDisplayName(configurationTarget.provider)} connection</small>
                </span>
                <IconButton
                  aria-label="Close integration configuration"
                  onClick={() => setConfigurationTarget(null)}
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
                  <strong>{configurationTarget.displayName}</strong>
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
                <Button onClick={() => setConfigurationTarget(null)} size="small" type="submit">
                  Done
                </Button>
              </footer>
            </section>
          </div>
        ) : null}
      </form>
    </AppShell>
  );
}
