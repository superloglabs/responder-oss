import { useMemo, useState } from "react";
import { ProviderGlyph } from "../components/icons";
import type { ProviderGlyphId } from "../components/provider-glyphs";
import {
  Alert,
  Button,
  Checkbox,
  IconButton,
  Panel,
  SegmentedControl,
} from "../design-system";
import { useDocumentTitle } from "../use-document-title";

type ProviderId = Exclude<ProviderGlyphId, "google">;
type StoryboardScenario =
  | "empty"
  | "connected"
  | "mixed"
  | "multiple"
  | "scoped"
  | "attention"
  | "async"
  | "secrets";
type IntegrationCategory =
  | "Observability"
  | "Code & deployment"
  | "Communication & workflow"
  | "Data & infrastructure";
type ConnectionStatus =
  | "automatic"
  | "available"
  | "connecting"
  | "enabled"
  | "error"
  | "pending"
  | "setup_required";
type ConfigurationKind = "github" | "linear" | "slack" | "vercel";

interface StoryboardIntegration {
  category: IntegrationCategory;
  description: string;
  id: ProviderId;
  name: string;
  searchTerms: string;
}

interface ConnectionInstance {
  configuration?: ConfigurationKind;
  detail: string;
  id: string;
  label: string;
  provider: ProviderId;
  status: ConnectionStatus;
}

interface ScenarioDefinition {
  description: string;
  instances: ConnectionInstance[];
  label: string;
}

const CATEGORY_ORDER: IntegrationCategory[] = [
  "Observability",
  "Code & deployment",
  "Communication & workflow",
  "Data & infrastructure",
];

const CATEGORY_DESCRIPTIONS: Record<IntegrationCategory, string> = {
  Observability: "Errors, logs, traces, and service health",
  "Code & deployment": "Source code, releases, and runtime changes",
  "Communication & workflow": "Team conversations and incident follow-up",
  "Data & infrastructure": "Cloud resources, databases, and custom tools",
};

const MULTI_INSTANCE_PROVIDERS = new Set<ProviderId>([
  "aws",
  "gcp",
  "custom_mcp",
  "langfuse",
]);

const INTEGRATIONS: StoryboardIntegration[] = [
  {
    category: "Observability",
    description: "Issues, events, traces, and release health",
    id: "sentry",
    name: "Sentry",
    searchTerms: "errors exceptions monitoring",
  },
  {
    category: "Observability",
    description: "Metrics, logs, traces, monitors, and dashboards",
    id: "datadog",
    name: "Datadog",
    searchTerms: "apm monitoring alerts observability",
  },
  {
    category: "Observability",
    description: "Logs, traces, metrics, and monitor history",
    id: "axiom",
    name: "Axiom",
    searchTerms: "logs traces metrics monitoring observability",
  },
  {
    category: "Observability",
    description: "Logs, traces, dashboards, and service health",
    id: "clickstack",
    name: "ClickStack / HyperDX",
    searchTerms: "logs traces monitoring hyperdx",
  },
  {
    category: "Observability",
    description: "LLM traces, observations, scores, and prompts",
    id: "langfuse",
    name: "Langfuse",
    searchTerms: "llm ai traces prompts evaluations projects",
  },
  {
    category: "Code & deployment",
    description: "Repositories, code search, issues, and pull requests",
    id: "github",
    name: "GitHub",
    searchTerms: "source code repositories pull requests organizations",
  },
  {
    category: "Code & deployment",
    description: "Projects, deployments, domains, and runtime logs",
    id: "vercel",
    name: "Vercel",
    searchTerms: "deployments hosting frontend logs projects",
  },
  {
    category: "Communication & workflow",
    description: "Channels, threads, alerts, and incident discussion",
    id: "slack",
    name: "Slack",
    searchTerms: "chat messages channels communication workspaces",
  },
  {
    category: "Communication & workflow",
    description: "Issues, projects, and incident follow-up",
    id: "linear",
    name: "Linear",
    searchTerms: "tickets tasks issues project management",
  },
  {
    category: "Data & infrastructure",
    description: "Architecture, telemetry, configuration, and service health",
    id: "aws",
    name: "AWS",
    searchTerms: "cloud infrastructure services iam accounts",
  },
  {
    category: "Data & infrastructure",
    description: "Asset inventory, logs, metrics, and alerting state",
    id: "gcp",
    name: "Google Cloud",
    searchTerms: "gcp cloud infrastructure projects logs metrics assets",
  },
  {
    category: "Data & infrastructure",
    description: "Redis, Vector, Search, QStash, and Workflow",
    id: "upstash",
    name: "Upstash",
    searchTerms: "database redis vector queue workflow",
  },
  {
    category: "Data & infrastructure",
    description: "Connect any MCP-compatible service",
    id: "custom_mcp",
    name: "Custom MCP",
    searchTerms: "custom tools server model context protocol",
  },
];

function instance(
  provider: ProviderId,
  status: ConnectionStatus,
  options: Partial<Omit<ConnectionInstance, "provider" | "status">> = {},
): ConnectionInstance {
  const integration = INTEGRATIONS.find((candidate) => candidate.id === provider)!;
  return {
    detail: integration.description,
    id: options.id ?? provider,
    label: options.label ?? integration.name,
    provider,
    status,
    ...options,
  };
}

const SCENARIOS: Record<StoryboardScenario, ScenarioDefinition> = {
  empty: {
    label: "Empty workspace",
    description: "No integrations are connected yet.",
    instances: [],
  },
  connected: {
    label: "Ready to enable",
    description: "Workspace connections exist, but this agent has none enabled.",
    instances: [
      instance("sentry", "available", { detail: "acme-production · Issues, events, and traces" }),
      instance("datadog", "available", { detail: "Acme US1 · Logs, traces, monitors, and service health" }),
      instance("github", "available", {
        configuration: "github",
        detail: "Acme · Choose repositories and pull request behavior",
      }),
      instance("slack", "available", {
        configuration: "slack",
        detail: "Acme · Choose channels for read-only message history",
      }),
    ],
  },
  mixed: {
    label: "Mixed assignment",
    description: "Automatic, enabled, and available context together.",
    instances: [
      instance("sentry", "automatic", { detail: "Included from the Sentry issue trigger" }),
      instance("github", "enabled", {
        configuration: "github",
        detail: "Acme · 2 repositories · Pull requests on request",
      }),
      instance("slack", "enabled", {
        configuration: "slack",
        detail: "Acme · 3 channels selected",
      }),
      instance("linear", "available", {
        configuration: "linear",
        detail: "Acme · Projects and issues · Context only",
      }),
      instance("aws", "available", { detail: "AWS · 123456789012 · Read-only role" }),
    ],
  },
  multiple: {
    label: "Multiple instances",
    description: "Projects, accounts, and MCP servers are enabled independently.",
    instances: [
      instance("langfuse", "enabled", {
        id: "langfuse-checkout",
        label: "Checkout assistant",
        detail: "Langfuse Cloud EU · Production project",
      }),
      instance("langfuse", "available", {
        id: "langfuse-support",
        label: "Support copilot",
        detail: "Langfuse Cloud US · Production project",
      }),
      instance("langfuse", "enabled", {
        id: "langfuse-evals",
        label: "Evaluation lab",
        detail: "Self-hosted Langfuse · Staging project",
      }),
      instance("aws", "enabled", {
        id: "aws-production",
        label: "Production",
        detail: "AWS · 123456789012 · Read-only role",
      }),
      instance("aws", "available", {
        id: "aws-staging",
        label: "Staging",
        detail: "AWS · 234567890123 · Read-only role",
      }),
      instance("custom_mcp", "enabled", {
        id: "mcp-metrics",
        label: "Production metrics",
        detail: "Custom MCP · 14 remote tools",
      }),
      instance("custom_mcp", "available", {
        id: "mcp-status",
        label: "Customer status",
        detail: "Custom MCP · 6 remote tools",
      }),
    ],
  },
  scoped: {
    label: "Scoped resources",
    description: "Connected providers require resource-level configuration.",
    instances: [
      instance("slack", "enabled", {
        configuration: "slack",
        detail: "Acme · 3 channels selected from one workspace",
      }),
      instance("github", "enabled", {
        configuration: "github",
        detail: "2 organizations · 4 repositories · Pull requests on request",
      }),
      instance("vercel", "available", {
        configuration: "vercel",
        detail: "Acme · No projects selected",
      }),
      instance("linear", "enabled", {
        configuration: "linear",
        detail: "Acme · Context only · Ticket creation off",
      }),
    ],
  },
  attention: {
    label: "Needs attention",
    description: "Connection lifecycle and deployment configuration states.",
    instances: [
      instance("sentry", "error", { detail: "acme-production · Credentials expired" }),
      instance("custom_mcp", "pending", {
        id: "mcp-oauth-pending",
        label: "Incident timeline",
        detail: "Waiting for OAuth authorization to finish",
      }),
      instance("vercel", "setup_required", { detail: "Provider app credentials required" }),
      instance("datadog", "connecting", { detail: "Validating API and application keys" }),
      instance("slack", "error", {
        detail: "Reconnect to grant channel history permissions",
      }),
    ],
  },
  async: {
    label: "Empty & async",
    description: "Loading, stale, empty, and no-result resource states.",
    instances: [
      instance("slack", "enabled", {
        configuration: "slack",
        detail: "3 saved channels · Refresh failed, showing the last list",
      }),
      instance("github", "available", {
        configuration: "github",
        detail: "Acme sandbox · No repositories available",
      }),
      instance("vercel", "available", {
        configuration: "vercel",
        detail: "Acme · No projects match “api”",
      }),
    ],
  },
  secrets: {
    label: "Workspace secrets",
    description: "Existing, selected, creating, and validation-error states.",
    instances: [
      instance("github", "enabled", {
        configuration: "github",
        detail: "Acme · 2 repositories selected",
      }),
      instance("aws", "enabled", { detail: "Production · Read-only role" }),
    ],
  },
};

const SCENARIO_ORDER = Object.keys(SCENARIOS) as StoryboardScenario[];

const RESOURCE_OPTIONS: Record<
  ConfigurationKind,
  Array<{ account?: "acme" | "labs"; description?: string; id: string; label: string }>
> = {
  slack: [
    { id: "slack-incidents", label: "#incidents" },
    { id: "slack-platform", label: "#platform-alerts" },
    { id: "slack-customer", label: "#customer-escalations" },
    { id: "slack-security", label: "#security" },
  ],
  github: [
    { account: "acme", description: "Private · main", id: "github-responder", label: "responder" },
    { account: "acme", description: "Private · main", id: "github-api", label: "api" },
    { account: "labs", description: "Private · trunk", id: "github-infra", label: "infrastructure" },
    { account: "labs", description: "Public · main", id: "github-sdk", label: "sdk" },
  ],
  vercel: [
    { account: "acme", id: "vercel-dashboard", label: "dashboard" },
    { account: "acme", id: "vercel-docs", label: "docs" },
    { account: "labs", id: "vercel-status", label: "status-page" },
  ],
  linear: [],
};

const SCENARIO_SELECTED_RESOURCE_IDS: Record<
  StoryboardScenario,
  string[]
> = {
  empty: [],
  connected: [],
  mixed: [
    "slack-incidents",
    "slack-platform",
    "slack-customer",
    "github-responder",
    "github-api",
  ],
  multiple: [],
  scoped: [
    "slack-incidents",
    "slack-platform",
    "slack-customer",
    "github-responder",
    "github-api",
    "vercel-dashboard",
    "vercel-docs",
  ],
  attention: [],
  async: [],
  secrets: ["github-responder", "github-api"],
};

function selectedResourcesForScenario(scenario: StoryboardScenario): Set<string> {
  return new Set(SCENARIO_SELECTED_RESOURCE_IDS[scenario]);
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="m16.5 16.5 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function CogIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function IntegrationIdentity({ instance: connection }: { instance: ConnectionInstance }) {
  const integration = INTEGRATIONS.find((candidate) => candidate.id === connection.provider)!;
  return (
    <div className="contextStoryboardIdentity">
      <ProviderGlyph
        className="contextStoryboardProvider"
        decorative
        provider={connection.provider}
      />
      <span>
        <strong>{connection.label}</strong>
        <small>
          {connection.label === integration.name ? "" : `${integration.name} · `}
          {connection.detail}
        </small>
      </span>
    </div>
  );
}

function ResourceConfigurationDialog({
  kind,
  onClose,
  onDone,
  selectedResources,
  setSelectedResources,
}: {
  kind: ConfigurationKind;
  onClose: () => void;
  onDone: () => void;
  selectedResources: Set<string>;
  setSelectedResources: (next: Set<string>) => void;
}) {
  const integration = INTEGRATIONS.find((candidate) => candidate.id === kind)!;
  const allOptions = RESOURCE_OPTIONS[kind];
  const initiallySelectedAccount =
    allOptions.find(
      (resource) =>
        resource.account && selectedResources.has(resource.id),
    )?.account ?? "acme";
  const [selectedAccount, setSelectedAccount] = useState<"acme" | "labs">(
    initiallySelectedAccount,
  );
  const options = allOptions.filter(
    (resource) => !resource.account || resource.account === selectedAccount,
  );
  const selectedForProvider = options.filter((resource) => selectedResources.has(resource.id)).length;
  const [ticketCreation, setTicketCreation] = useState(false);
  const [prMode, setPrMode] = useState<"manual" | "always">("manual");

  function toggle(resourceId: string) {
    const next = new Set(selectedResources);
    if (next.has(resourceId)) next.delete(resourceId);
    else next.add(resourceId);
    setSelectedResources(next);
  }

  function selectAccount(account: "acme" | "labs") {
    setSelectedAccount(account);
    const next = new Set(selectedResources);
    for (const resource of allOptions) next.delete(resource.id);
    setSelectedResources(next);
  }

  return (
    <div
      className="configurationDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby="storyboard-configuration-title"
        aria-modal="true"
        className="configurationDialog contextStoryboardConfiguration"
        role="dialog"
      >
        <header className="configurationDialog__header">
          <ProviderGlyph
            className="contextStoryboardProvider"
            decorative
            provider={kind}
          />
          <span className="configurationDialog__copy">
            <strong id="storyboard-configuration-title">Configure {integration.name}</strong>
            <small>
              {kind === "slack"
                ? "Choose one or more channels from one Slack workspace."
                : kind === "github"
                  ? "Choose repositories and pull request behavior."
                  : kind === "vercel"
                    ? "Choose only the projects this agent may inspect."
                    : "Control ticket creation and issue content."}
            </small>
          </span>
          <IconButton aria-label="Close configuration" onClick={onClose} size="small" variant="ghost">
            ×
          </IconButton>
        </header>
        <div className="configurationDialog__body">
          {kind === "github" || kind === "vercel" ? (
            <label className="contextStoryboardDialogSelect">
              <span>{kind === "github" ? "Organization" : "Vercel account"}</span>
              <select
                onChange={(event) =>
                  selectAccount(event.target.value as "acme" | "labs")
                }
                value={selectedAccount}
              >
                <option value="acme">Acme production</option>
                <option value="labs">Acme labs</option>
              </select>
            </label>
          ) : null}
          {kind === "linear" ? (
            <div className="contextStoryboardLinearConfig">
              <Checkbox
                checked={ticketCreation}
                description="Let the agent choose a project and create a matching ticket."
                label="Create Linear tickets for issues"
                onChange={(event) => setTicketCreation(event.target.checked)}
              />
              <label>
                <span>Issue description template</span>
                <textarea
                  defaultValue="{{description}}\n\nSeverity: {{severity}}\n\n{{evidence}}"
                  disabled={!ticketCreation}
                  rows={6}
                />
              </label>
            </div>
          ) : (
            <div className="contextStoryboardResourceList">
              {options.map((resource) => (
                <Checkbox
                  checked={selectedResources.has(resource.id)}
                  description={resource.description}
                  key={resource.id}
                  label={resource.label}
                  onChange={() => toggle(resource.id)}
                />
              ))}
            </div>
          )}
          {kind === "github" ? (
            <div className="contextStoryboardDialogSetting">
              <span>
                <strong>Pull request fixes</strong>
                <small>What should happen when the agent finds a safe fix?</small>
              </span>
              <SegmentedControl
                aria-label="Pull request behavior"
                onChange={setPrMode}
                options={[
                  { label: "On request", value: "manual" },
                  { label: "Always", value: "always" },
                ]}
                value={prMode}
              />
            </div>
          ) : null}
        </div>
        <footer className="configurationDialog__footer">
          <span>{kind === "linear" ? (ticketCreation ? "Ticket creation on" : "Context only") : `${selectedForProvider} selected`}</span>
          <Button onClick={onDone} size="small" variant="primary">Done</Button>
        </footer>
      </section>
    </div>
  );
}

function ConnectionConfigurationDialog({
  connection,
  onClose,
}: {
  connection: ConnectionInstance;
  onClose: () => void;
}) {
  const integration = INTEGRATIONS.find((candidate) => candidate.id === connection.provider)!;
  return (
    <div
      className="configurationDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby="storyboard-connection-title"
        aria-modal="true"
        className="configurationDialog contextStoryboardConfiguration"
        role="dialog"
      >
        <header className="configurationDialog__header">
          <ProviderGlyph
            className="contextStoryboardProvider"
            decorative
            provider={connection.provider}
          />
          <span className="configurationDialog__copy">
            <strong id="storyboard-connection-title">Configure {connection.label}</strong>
            <small>{integration.name} connection settings</small>
          </span>
          <IconButton aria-label="Close configuration" onClick={onClose} size="small" variant="ghost">
            ×
          </IconButton>
        </header>
        <div className="configurationDialog__body">
          <label className="contextStoryboardDialogSelect">
            <span>Connection name</span>
            <input defaultValue={connection.label} />
          </label>
          <div className="contextStoryboardConnectionSummary">
            <span>Connected provider</span>
            <strong>{integration.name}</strong>
            <small>{connection.detail}</small>
          </div>
        </div>
        <footer className="configurationDialog__footer">
          <span>Connection settings</span>
          <Button onClick={onClose} size="small" variant="primary">Done</Button>
        </footer>
      </section>
    </div>
  );
}

function AsyncStateSamples() {
  return (
    <section aria-labelledby="async-state-title" className="contextStoryboardSampleSection">
      <header>
        <h2 id="async-state-title">Resource picker states</h2>
        <p>States that appear inside provider configuration.</p>
      </header>
      <div className="contextStoryboardSampleGrid">
        <article>
          <span className="contextStoryboardSampleLabel"><i className="dsSpinner" /> Refreshing</span>
          <strong>Slack channels</strong>
          <small>Refreshing channels…</small>
          <Alert title="Could not refresh channels" tone="danger">Showing the last available list.</Alert>
        </article>
        <article>
          <span className="contextStoryboardSampleLabel">Empty</span>
          <strong>GitHub repositories</strong>
          <small>No repositories are available for this organization.</small>
          <Button size="small" variant="secondary">Choose another organization</Button>
        </article>
        <article>
          <span className="contextStoryboardSampleLabel">No results</span>
          <strong>Vercel projects</strong>
          <small>No projects match “api”.</small>
          <Button size="small" variant="secondary">Clear search</Button>
        </article>
      </div>
    </section>
  );
}

function SecretsStoryboard() {
  const [selected, setSelected] = useState(new Set(["openai-api-key"]));
  const [creating, setCreating] = useState(false);

  function toggle(secretId: string) {
    const next = new Set(selected);
    if (next.has(secretId)) next.delete(secretId);
    else next.add(secretId);
    setSelected(next);
  }

  return (
    <section aria-labelledby="secret-state-title" className="contextStoryboardSampleSection">
      <header>
        <h2 id="secret-state-title">Workspace secrets</h2>
        <p>Selected secrets resolve only for their allowed hosts.</p>
        <Button onClick={() => setCreating((current) => !current)} size="small" variant="secondary">
          {creating ? "Close form" : "Add secret"}
        </Button>
      </header>
      <div className="contextStoryboardSecretList">
        {[
          ["openai-api-key", "OPENAI_API_KEY", "api.openai.com"],
          ["statuspage-token", "STATUSPAGE_TOKEN", "api.statuspage.io"],
        ].map(([id, name, hosts]) => (
          <div key={id}>
            <span><strong>{name}</strong><small>Allowed for {hosts}</small></span>
            <Button onClick={() => toggle(id)} size="small" variant={selected.has(id) ? "ghost" : "secondary"}>
              {selected.has(id) ? "Remove" : "Add"}
            </Button>
          </div>
        ))}
      </div>
      {creating ? (
        <div className="contextStoryboardSecretForm">
          <label><span>Environment variable</span><input defaultValue="SERVICE_API_KEY" /></label>
          <label><span>Secret value</span><input placeholder="Stored once and never shown again" type="password" /></label>
          <label><span>Allowed hosts</span><input aria-invalid="true" placeholder="api.example.com" /></label>
          <Button disabled size="small" variant="secondary">Store and add</Button>
          <p role="alert">Add at least one allowed host.</p>
        </div>
      ) : null}
    </section>
  );
}

export function AgentContextStoryboardPage() {
  useDocumentTitle("Agent context storyboard");
  const [scenario, setScenario] = useState<StoryboardScenario>("mixed");
  const [instances, setInstances] = useState<ConnectionInstance[]>(
    () => SCENARIOS.mixed.instances.map((connection) => ({ ...connection })),
  );
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [configurationOpen, setConfigurationOpen] = useState<ConnectionInstance | null>(null);
  const [selectedResources, setSelectedResources] = useState(
    () => selectedResourcesForScenario("mixed"),
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleIntegrations = useMemo(
    () =>
      INTEGRATIONS.filter((integration) => {
        const alreadyConnected = instances.some(
          (connection) => connection.provider === integration.id,
        );
        if (alreadyConnected && !MULTI_INSTANCE_PROVIDERS.has(integration.id)) {
          return false;
        }
        return `${integration.name} ${integration.description} ${integration.category} ${integration.searchTerms}`
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      }),
    [instances, normalizedQuery],
  );
  function selectScenario(nextScenario: StoryboardScenario) {
    setScenario(nextScenario);
    setInstances(SCENARIOS[nextScenario].instances.map((connection) => ({ ...connection })));
    setQuery("");
    setAnnouncement("");
    setConfigurationOpen(null);
    setSelectedResources(selectedResourcesForScenario(nextScenario));
  }

  function updateInstance(connectionId: string, status: ConnectionStatus) {
    setInstances((current) =>
      current.map((connection) =>
        connection.id === connectionId ? { ...connection, status } : connection,
      ),
    );
    const connection = instances.find((candidate) => candidate.id === connectionId);
    if (connection) {
      setAnnouncement(
        `${connection.label} ${status === "enabled" ? "enabled for" : "removed from"} this agent.`,
      );
    }
  }

  function connectIntegration(integration: StoryboardIntegration) {
    const existing = instances.filter((connection) => connection.provider === integration.id);
    const nextNumber = existing.length + 1;
    const label = MULTI_INSTANCE_PROVIDERS.has(integration.id) && existing.length > 0
      ? `New ${integration.id === "langfuse" || integration.id === "gcp" ? "project" : integration.id === "aws" ? "account" : "MCP server"} ${nextNumber}`
      : integration.name;
    const configuration =
      integration.id === "github" ||
      integration.id === "linear" ||
      integration.id === "slack" ||
      integration.id === "vercel"
        ? integration.id
        : undefined;
    setInstances((current) => [
      ...current,
      instance(integration.id, "enabled", {
        configuration,
        id: `${integration.id}-story-${nextNumber}`,
        label,
        detail: integration.description,
      }),
    ]);
    setAnnouncement(`${label} connected and enabled for this agent.`);
  }

  function assignmentToggle(connection: ConnectionInstance) {
    const isEnabled = connection.status === "automatic" || connection.status === "enabled";
    return (
      <button
        aria-checked={isEnabled}
        aria-label={`${isEnabled ? "Disable" : "Enable"} ${connection.label} for this agent`}
        className="contextStoryboardToggle"
        onClick={() => updateInstance(connection.id, isEnabled ? "available" : "enabled")}
        role="switch"
        type="button"
      >
        <i aria-hidden="true"><i /></i>
      </button>
    );
  }

  function actionFor(connection: ConnectionInstance) {
    return (
      <div className="contextStoryboardScopedActions">
        <IconButton
          aria-label={`Configure ${connection.label}`}
          onClick={() => setConfigurationOpen(connection)}
          size="small"
          variant="ghost"
        >
          <CogIcon />
        </IconButton>
        {assignmentToggle(connection)}
      </div>
    );
  }

  function catalogAction(integration: StoryboardIntegration) {
    return {
      disabled: false,
      label: "Add",
      onClick: () => connectIntegration(integration),
      variant: "primary" as const,
    };
  }

  return (
    <main className="contextStoryboardPage">
      <header className="contextStoryboardHeader">
        <div>
          <span className="contextStoryboardEyebrow">Storyboard · Agent setup</span>
          <h1>Agent context</h1>
          <p>Choose the integrations this agent can use while investigating.</p>
        </div>
        <label className="contextStoryboardScenarioPicker">
          <span>Try a starting state</span>
          <select
            aria-label="Storyboard starting state"
            onChange={(event) => selectScenario(event.target.value as StoryboardScenario)}
            value={scenario}
          >
            {SCENARIO_ORDER.map((value) => (
              <option key={value} value={value}>{SCENARIOS[value].label}</option>
            ))}
          </select>
          <small>{SCENARIOS[scenario].description}</small>
        </label>
      </header>

      <div className="contextStoryboardLayout">
        <nav aria-label="Agent setup progress" className="contextStoryboardSteps">
          {[
            ["1", "Input", "Trigger and source"],
            ["2", "Output", "Channel and routing"],
            ["3", "Agent context", "Tools and repositories"],
            ["4", "Prompt", "Investigation instructions"],
          ].map(([number, title, description]) => (
            <div
              className={`contextStoryboardStep ${
                number === "3" ? "isCurrent" : Number(number) < 3 ? "isComplete" : ""
              }`}
              key={number}
            >
              <span>{Number(number) < 3 ? "✓" : number}</span>
              <div><strong>{title}</strong><small>{description}</small></div>
            </div>
          ))}
        </nav>

        <div className="contextStoryboardCanvas">
          <Panel className="contextStoryboardPanel" padding="default" surface="base">
            <section aria-labelledby="enabled-integrations-title" className="contextStoryboardSection">
              <header className="contextStoryboardSectionHeader">
                <div>
                  <h2 id="enabled-integrations-title">Connected integrations</h2>
                  <p>Turn each integration on or off and configure its access.</p>
                </div>
              </header>

              {instances.length > 0 ? (
                <div className="contextStoryboardConnectedList">
                  {instances.map((connection) => (
                    <div
                      className="contextStoryboardConnectedRow"
                      key={connection.id}
                    >
                      <IntegrationIdentity instance={connection} />
                      <span className="contextStoryboardRowAction">{actionFor(connection)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="contextStoryboardEmpty">
                  <span aria-hidden="true">+</span>
                  <div>
                    <strong>No integrations connected yet</strong>
                    <p>Choose one below to connect it and make it available to this agent.</p>
                  </div>
                </div>
              )}
            </section>

            {scenario === "async" ? <AsyncStateSamples /> : null}
            {scenario === "secrets" ? <SecretsStoryboard /> : null}

            <section aria-labelledby="integration-catalog-title" className="contextStoryboardSection">
              <header className="contextStoryboardCatalogHeader">
                <div>
                  <h2 id="integration-catalog-title">Add integration</h2>
                  <p>Browse by category or search by the kind of context you need.</p>
                </div>
                <label className="contextStoryboardSearch">
                  <SearchIcon />
                  <span className="srOnly">Search integrations</span>
                  <input
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search integrations…"
                    type="search"
                    value={query}
                  />
                  {query ? <button aria-label="Clear search" onClick={() => setQuery("")} type="button">×</button> : null}
                </label>
              </header>

              {visibleIntegrations.length > 0 ? (
                <div className="contextStoryboardCatalog">
                  {CATEGORY_ORDER.map((category) => {
                    const categoryIntegrations = visibleIntegrations.filter(
                      (integration) => integration.category === category,
                    );
                    if (categoryIntegrations.length === 0) return null;
                    return (
                          <section className="contextStoryboardCategory" key={category}>
                            <header><h3>{category}</h3><p>{CATEGORY_DESCRIPTIONS[category]}</p></header>
                            <div className="contextStoryboardGrid">
                              {categoryIntegrations.map((integration) => {
                                const action = catalogAction(integration);
                                return (
                                  <article className="contextStoryboardCard" key={integration.id}>
                                    <IntegrationIdentity instance={instance(integration.id, "available")} />
                                    <div className="contextStoryboardCardFooter">
                                      <Button
                                        disabled={action.disabled}
                                        onClick={action.onClick}
                                        size="small"
                                        variant={action.variant}
                                      >
                                        {action.label}
                                      </Button>
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                          </section>
                    );
                  })}
                </div>
              ) : (
                <div className="contextStoryboardNoResults">
                  <strong>No integrations match “{query}”</strong>
                  <p>Try a provider name, category, or capability such as “logs” or “database”.</p>
                  <Button onClick={() => setQuery("")} size="small" variant="secondary">Clear search</Button>
                </div>
              )}
            </section>
          </Panel>

          <footer className="contextStoryboardActions">
            <span aria-live="polite">{announcement}</span>
            <Button variant="ghost">Back</Button>
            <Button variant="primary">Continue</Button>
          </footer>
        </div>
      </div>

      {configurationOpen ? (
        configurationOpen.configuration ? (
          <ResourceConfigurationDialog
            kind={configurationOpen.configuration}
            onClose={() => setConfigurationOpen(null)}
            onDone={() => setConfigurationOpen(null)}
            selectedResources={selectedResources}
            setSelectedResources={setSelectedResources}
          />
        ) : (
          <ConnectionConfigurationDialog
            connection={configurationOpen}
            onClose={() => setConfigurationOpen(null)}
          />
        )
      ) : null}
    </main>
  );
}
