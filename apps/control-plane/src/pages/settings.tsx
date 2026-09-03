import { useEffect, useState } from "react";
import { AppShell } from "../components/app-shell";
import {
  DatadogConnectionDialog,
} from "../components/datadog-site-dialog";
import { ClickStackConnectionDialog } from "../components/clickstack-connection-dialog";
import { AwsConnectionDialog } from "../components/aws-connection-dialog";
import { GcpConnectionDialog } from "../components/gcp-connection-dialog";
import { CustomMcpConnectionDialog } from "../components/custom-mcp-dialog";
import { UpstashConnectionDialog } from "../components/upstash-connection-dialog";
import { LangfuseConnectionDialog } from "../components/langfuse-connection-dialog";
import {
  Dash0ConnectionDialog,
  Dash0WebhookSetupDialog,
} from "../components/dash0-connection-dialog";
import { ArrowIcon, ProviderGlyph } from "../components/icons";
import { providerDisplayName } from "../components/provider-glyphs";
import { SettingsTabs } from "../components/settings-tabs";
import { IntegrationSettingsSkeleton } from "../components/screen-skeletons";
import { useDocumentTitle } from "../use-document-title";
import { integrationActionUrl } from "./settings-presentation";

type IntegrationState =
  | "available"
  | "coming_soon"
  | "connected"
  | "setup_required";

interface IntegrationSummary {
  id:
    | "aws"
    | "gcp"
    | "github"
    | "slack"
    | "sentry"
    | "datadog"
    | "dash0"
    | "posthog"
    | "axiom"
    | "upstash"
    | "langfuse"
    | "vercel"
    | "custom_mcp"
    | "clickstack"
    | "linear";
  name: string;
  description: string;
  state: IntegrationState;
  accountCount: number;
  resourceCount: number;
  accounts: Array<{
    id: string;
    displayName: string;
    status: "connected" | "error" | "pending";
    resourceCount: number;
    updatedAt: string;
    projectId?: string;
    projectNumber?: string;
  }>;
  connectUrl: string | null;
  configurationUrl: string | null;
}

interface IntegrationResponse {
  integrations: IntegrationSummary[];
}

type SentryHealth =
  | "checking"
  | "working"
  | "needs_reconnect"
  | "unavailable";

interface SentryCheckResponse {
  accounts: Array<{
    id: string;
    resourceCount?: number;
    status: Exclude<SentryHealth, "checking">;
  }>;
}

function connectionNotice(): {
  tone: "error" | "success" | "warning";
  message: string;
} | null {
  const search = new URLSearchParams(window.location.search);
  const provider = search.get("integration");
  const status = search.get("status");
  if (!provider || !status) return null;

  const name = providerDisplayName(provider);
  if (status === "connected") {
    const disabledAgentCount = Number(search.get("disabled_agents"));
    if (
      provider === "github" &&
      Number.isSafeInteger(disabledAgentCount) &&
      disabledAgentCount > 0
    ) {
      const agentLabel = disabledAgentCount === 1 ? "agent was" : "agents were";
      return {
        tone: "warning",
        message: `GitHub access updated. ${disabledAgentCount} ${agentLabel} paused because GitHub no longer gives them access to every configured repository. Open Agents to review them.`,
      };
    }
    return { tone: "success", message: `${name} connected successfully.` };
  }
  if (status === "finishing") {
    return {
      tone: "success",
      message: `${name} is finishing its connection. Projects will appear shortly.`,
    };
  }

  const reason = search.get("reason");
  const detail =
    reason === "already_connected"
      ? "That account is already connected to another workspace."
      : reason === "cancelled"
        ? "The connection was cancelled."
        : reason === "manual_uninstall_required"
          ? "This installation must be disconnected before Sentry will allow it to reconnect."
        : "The connection could not be completed.";
  return { tone: "error", message: `${name}: ${detail}` };
}

export function SettingsPage() {
  useDocumentTitle("Settings");
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sentryHealth, setSentryHealth] = useState<SentryHealth | null>(null);
  const [notice] = useState(connectionNotice);
  const isFinishingSentryConnection =
    new URLSearchParams(window.location.search).get("integration") === "sentry" &&
    new URLSearchParams(window.location.search).get("status") === "finishing";

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    let sentryRetryTimer: number | undefined;
    let retryCount = 0;
    let sentryCheckAttempts = 0;
    let sentryCheckStarted = false;

    function retrySentryCheck() {
      if (sentryCheckAttempts >= 2 || sentryRetryTimer !== undefined) return;
      sentryCheckStarted = false;
      sentryRetryTimer = window.setTimeout(() => {
        sentryRetryTimer = undefined;
        if (active) loadIntegrations();
      }, 2_000);
    }

    function checkSentryConnection() {
      sentryCheckStarted = true;
      sentryCheckAttempts += 1;
      setSentryHealth("checking");
      void fetch("/api/integrations/sentry/check", { method: "POST" })
        .then(async (response) => {
          if (!response.ok) throw new Error("Unable to check Sentry");
          return (await response.json()) as SentryCheckResponse;
        })
        .then((response) => {
          if (!active) return;
          const statuses = response.accounts.map((account) => account.status);
          if (statuses.includes("needs_reconnect")) {
            setSentryHealth("needs_reconnect");
            loadIntegrations();
          } else if (statuses.includes("unavailable") || statuses.length === 0) {
            setSentryHealth("unavailable");
            retrySentryCheck();
          } else {
            setSentryHealth("working");
            loadIntegrations();
          }
        })
        .catch(() => {
          if (active) {
            setSentryHealth("unavailable");
            retrySentryCheck();
          }
        });
    }

    function loadIntegrations() {
      void fetch("/api/integrations")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load integrations");
        return (await response.json()) as IntegrationResponse;
      })
      .then((response) => {
        if (!active) return;
        setIntegrations(response.integrations);
        const sentry = response.integrations.find(
          (integration) => integration.id === "sentry",
        );
        const sentryConnected = sentry?.state === "connected";
        if (sentry?.accounts.some((account) => account.status === "error")) {
          setSentryHealth("needs_reconnect");
        }
        if (sentryConnected && !sentryCheckStarted) {
          checkSentryConnection();
        }
        if (isFinishingSentryConnection && !sentryConnected && retryCount < 8) {
          retryCount += 1;
          retryTimer = window.setTimeout(loadIntegrations, 750);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(
            cause instanceof Error ? cause.message : "Unable to load integrations",
          );
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    }

    loadIntegrations();

    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (sentryRetryTimer !== undefined) {
        window.clearTimeout(sentryRetryTimer);
      }
    };
  }, [isFinishingSentryConnection]);

  const featured = integrations.filter((integration) =>
    ["github", "slack"].includes(integration.id),
  );
  const secondary = integrations.filter((integration) =>
    [
      "aws",
      "gcp",
      "sentry",
      "datadog",
      "dash0",
      "posthog",
      "axiom",
      "upstash",
      "langfuse",
      "linear",
      "vercel",
      "custom_mcp",
      "clickstack",
    ].includes(
      integration.id,
    ),
  );

  return (
    <AppShell active="settings" density="settings">
      <section className="settingsHeading">
        <h1>Settings</h1>
        <p>Manage your workspace, members, and connected services.</p>
      </section>

      <SettingsTabs active="integrations" />

      {notice ? (
        <p
          className={`settingsNotice settingsNotice--${notice.tone}`}
          role={notice.tone === "success" ? undefined : "alert"}
        >
          {notice.message}
        </p>
      ) : null}

      <section aria-labelledby="integrations-title" className="integrationBento">
        <h2 className="srOnly" id="integrations-title">
          Integrations
        </h2>
        {isLoading ? <IntegrationSettingsSkeleton /> : null}
        {error ? <p className="integrationMessage integrationMessage--error">{error}</p> : null}

        {!isLoading && !error ? (
          <div className="integrationRows">
            <div className="integrationRow integrationRow--featured">
              {featured.map((integration) => (
                <IntegrationCard
                  integration={integration}
                  key={integration.id}
                  sentryHealth={sentryHealth}
                />
              ))}
            </div>
            <div className="integrationRow">
              {secondary.map((integration) => (
                <IntegrationCard
                  integration={integration}
                  key={integration.id}
                  sentryHealth={sentryHealth}
                />
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

function displayedSentryHealth(
  integration: IntegrationSummary,
  health: SentryHealth | null,
): SentryHealth | null {
  if (integration.id !== "sentry") return null;
  if (integration.accounts.some((account) => account.status === "error")) {
    return "needs_reconnect";
  }
  return health ?? (integration.state === "connected" ? "checking" : null);
}

function integrationDetail(
  integration: IntegrationSummary,
  sentryHealth: SentryHealth | null,
): string {
  const health = displayedSentryHealth(integration, sentryHealth);
  if (health === "checking") return "Checking the connection…";
  if (health === "working") {
    const projectLabel = integration.resourceCount === 1 ? "project" : "projects";
    return `Connection works · ${integration.resourceCount} ${projectLabel}`;
  }
  if (health === "needs_reconnect") {
    const failedCount = Math.max(
      1,
      integration.accounts.filter((account) => account.status === "error").length,
    );
    return failedCount === 1
      ? "1 connection failed · Select to reconnect"
      : `${failedCount} connections failed · Select to reconnect`;
  }
  if (health === "unavailable") return "Could not verify the connection right now";
  if (integration.state === "connected") {
    const accountLabel = integration.accountCount === 1 ? "account" : "accounts";
    const resourceLabel = integration.resourceCount === 1 ? "resource" : "resources";
    return `${integration.resourceCount} ${resourceLabel} · ${integration.accountCount} ${accountLabel}`;
  }
  if (integration.state === "setup_required") {
    return "Provider app credentials required";
  }
  if (integration.state === "coming_soon") {
    return "Connection flow coming next";
  }
  return integration.description;
}

function IntegrationCard({
  integration,
  sentryHealth,
}: {
  integration: IntegrationSummary;
  sentryHealth: SentryHealth | null;
}) {
  if (integration.id === "gcp") {
    return <GcpIntegrationCard integration={integration} />;
  }
  if (integration.id === "sentry") {
    return (
      <SentryIntegrationCard
        integration={integration}
        sentryHealth={sentryHealth}
      />
    );
  }
  return <DefaultIntegrationCard integration={integration} sentryHealth={sentryHealth} />;
}

function DefaultIntegrationCard({
  integration,
  sentryHealth,
}: {
  integration: IntegrationSummary;
  sentryHealth: SentryHealth | null;
}) {
  const actionUrl = integrationActionUrl(integration);
  const health = displayedSentryHealth(integration, sentryHealth);
  const canConnect = Boolean(actionUrl);
  const [isConnecting, setIsConnecting] = useState(false);
  const [choosingDatadogSite, setChoosingDatadogSite] = useState(false);
  const [configuringCustomMcp, setConfiguringCustomMcp] = useState(false);
  const [connectingUpstash, setConnectingUpstash] = useState(false);
  const [connectingLangfuse, setConnectingLangfuse] = useState(false);
  const [connectingDash0, setConnectingDash0] = useState(false);
  const returnedAccountId = new URLSearchParams(window.location.search).get(
    "integration_account_id",
  );
  const [configuringDash0Webhook, setConfiguringDash0Webhook] = useState(
    integration.id === "dash0" &&
      new URLSearchParams(window.location.search).get("integration") === "dash0" &&
      new URLSearchParams(window.location.search).get("status") === "connected",
  );
  const [connectingClickStack, setConnectingClickStack] = useState(false);
  const [connectingAws, setConnectingAws] = useState(false);

  function startConnection() {
    if (!actionUrl || isConnecting) return;
    if (integration.id === "datadog") {
      setChoosingDatadogSite(true);
      return;
    }
    if (integration.id === "dash0") {
      if (integration.state === "connected") setConfiguringDash0Webhook(true);
      else setConnectingDash0(true);
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
    if (integration.id === "clickstack") {
      setConnectingClickStack(true);
      return;
    }
    if (integration.id === "aws") {
      setConnectingAws(true);
      return;
    }
    setChoosingDatadogSite(false);
    setIsConnecting(true);
    const url = new URL(actionUrl, window.location.origin);
    window.location.assign(`${url.pathname}${url.search}`);
  }

  return (
    <>
      <button
        aria-busy={isConnecting}
        aria-disabled={!canConnect}
        className={`integrationCard ${integration.id === "github" ? "isFeatured" : ""}`}
        disabled={!canConnect || isConnecting}
        onClick={() => startConnection()}
        type="button"
      >
        <span className="integrationCard__top">
          <ProviderGlyph
            className={`integrationLogo integrationLogo--${integration.id === "custom_mcp" ? "mcp" : integration.id}`}
            decorative
            provider={integration.id}
          />
          {health === "needs_reconnect" ? (
            <span className="connectedBadge connectedBadge--warning">Reconnect</span>
          ) : health === "unavailable" ? (
            <span className="connectedBadge connectedBadge--muted">Not verified</span>
          ) : health === "checking" ? (
            <span className="connectedBadge connectedBadge--muted">Checking</span>
          ) : health === "working" ? (
            <span className="connectedBadge">Working</span>
          ) : integration.state === "connected" ? (
            <span className="connectedBadge">Connected</span>
          ) : integration.state === "coming_soon" ? (
            <span className="connectedBadge connectedBadge--muted">Coming next</span>
          ) : null}
        </span>
        <span className="integrationCard__body">
          <strong>{integration.name}</strong>
          <small>{integrationDetail(integration, sentryHealth)}</small>
        </span>
        <span className="integrationCard__arrow">
          {isConnecting ? (
            <span aria-hidden="true" className="buttonSpinner" />
          ) : (
            <ArrowIcon />
          )}
        </span>
      </button>
      <DatadogConnectionDialog
        connectUrl={integration.connectUrl ?? ""}
        onCancel={() => setChoosingDatadogSite(false)}
        open={choosingDatadogSite}
        returnTo="/settings"
      />
      <CustomMcpConnectionDialog
        connectUrl={integration.connectUrl ?? ""}
        onCancel={() => setConfiguringCustomMcp(false)}
        open={configuringCustomMcp}
        returnTo="/settings"
      />
      <UpstashConnectionDialog
        connectUrl={integration.connectUrl ?? ""}
        onCancel={() => setConnectingUpstash(false)}
        open={connectingUpstash}
        returnTo="/settings"
      />
      <LangfuseConnectionDialog
        connectUrl={integration.connectUrl ?? ""}
        onCancel={() => setConnectingLangfuse(false)}
        open={connectingLangfuse}
        returnTo="/settings"
      />
      <Dash0ConnectionDialog
        connectUrl={integration.connectUrl ?? ""}
        onCancel={() => setConnectingDash0(false)}
        open={connectingDash0}
        returnTo="/settings"
      />
      <Dash0WebhookSetupDialog
        accountId={
          returnedAccountId ?? integration.accounts[0]?.id ?? ""
        }
        onClose={() => setConfiguringDash0Webhook(false)}
        open={configuringDash0Webhook}
      />
      <ClickStackConnectionDialog
        connectUrl={integration.connectUrl ?? ""}
        onCancel={() => setConnectingClickStack(false)}
        open={connectingClickStack}
        returnTo="/settings"
      />
      <AwsConnectionDialog
        connectUrl={integration.connectUrl ?? ""}
        onCancel={() => setConnectingAws(false)}
        open={connectingAws}
        returnTo="/settings"
      />
    </>
  );
}

function GcpIntegrationCard({
  integration,
}: {
  integration: IntegrationSummary;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reconnectProject, setReconnectProject] = useState<{
    displayName: string;
    projectId: string;
    projectNumber: string;
  } | undefined>();
  const [removingAccountId, setRemovingAccountId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const canConnect = Boolean(integration.connectUrl);

  return (
    <article className="integrationCard integrationCard--managed">
      <div className="integrationCard__top">
        <ProviderGlyph
          className="integrationLogo integrationLogo--gcp"
          decorative
          provider="gcp"
        />
        {integration.accounts.some((account) => account.status === "error") ? (
          <span className="connectedBadge connectedBadge--warning">Action needed</span>
        ) : integration.accountCount > 0 ? (
          <span className="connectedBadge">Connected</span>
        ) : null}
      </div>
      <div className="integrationCard__body">
        <strong>Google Cloud</strong>
        <small>
          {integration.accountCount > 0
            ? `${integration.accountCount} connected project${integration.accountCount === 1 ? "" : "s"}`
            : "Read-only infrastructure, logs, metrics, and alert context."}
        </small>
        {integration.accounts.length > 0 ? (
          <ul className="integrationCard__accounts" aria-label="Connected Google Cloud projects">
            {integration.accounts.map((account) => (
              <li key={account.id}>
                <span>
                  <strong>{account.displayName.replace(/^GCP · /u, "")}</strong>
                  <small>
                    {account.projectNumber
                      ? `Project number ${account.projectNumber}`
                      : account.status === "pending"
                        ? "Setup pending"
                        : account.status === "error"
                          ? "Needs attention"
                          : "Read-only access"}
                  </small>
                </span>
                <span className="integrationCard__accountStatus">
                  {account.status === "connected"
                    ? "Connected"
                    : account.status === "pending"
                      ? "Pending"
                      : "Error"}
                </span>
                <span className="integrationCard__accountActions">
                  {account.projectNumber ? (
                    <button
                      className="button button--secondary button--small"
                      onClick={() => {
                        setReconnectProject({
                          displayName: account.displayName.replace(/^GCP · /u, ""),
                          projectId: account.projectId ?? account.displayName.replace(/^GCP · /u, ""),
                          projectNumber: account.projectNumber!,
                        });
                        setDialogOpen(true);
                      }}
                      type="button"
                    >
                      Reconnect
                    </button>
                  ) : null}
                  <button
                    className="button button--secondary button--small"
                    disabled={removingAccountId === account.id}
                    onClick={() => {
                      if (!window.confirm(
                        `Remove ${account.displayName.replace(/^GCP · /u, "")} from Responder? This does not revoke IAM in Google Cloud.`,
                      )) return;
                      setRemoveError(null);
                      setRemovingAccountId(account.id);
                      void fetch(`/api/integrations/gcp/${account.id}`, { method: "DELETE" })
                        .then(async (response) => {
                          if (!response.ok) {
                            const body = (await response.json().catch(() => null)) as { error?: string } | null;
                            throw new Error(body?.error ?? "Unable to remove the project");
                          }
                          window.location.reload();
                        })
                        .catch((cause: unknown) => {
                          setRemoveError(cause instanceof Error ? cause.message : "Unable to remove the project");
                          setRemovingAccountId(null);
                        });
                    }}
                    type="button"
                  >
                    {removingAccountId === account.id ? "Removing…" : "Remove"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {removeError ? <p className="siteDialog__error">{removeError}</p> : null}
      <div className="integrationCard__actions">
        {canConnect ? (
          <button
            className="button button--primary button--small"
            onClick={() => setDialogOpen(true)}
            type="button"
          >
            Add project manually
          </button>
        ) : (
          <small>Provider configuration required</small>
        )}
      </div>
      <GcpConnectionDialog
        connectUrl={integration.connectUrl ?? "/api/integrations/gcp/connect"}
        initialProject={reconnectProject}
        key={reconnectProject?.projectId ?? "manual"}
        onCancel={() => {
          setDialogOpen(false);
          setReconnectProject(undefined);
        }}
        open={dialogOpen}
        returnTo="/settings"
      />
    </article>
  );
}

function SentryIntegrationCard({
  integration,
  sentryHealth,
}: {
  integration: IntegrationSummary;
  sentryHealth: SentryHealth | null;
}) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [removingAccountId, setRemovingAccountId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [manualRemoval, setManualRemoval] = useState<{
    accountId: string;
    manualUninstallUrl: string;
    message: string;
  } | null>(null);
  const canConnect = Boolean(integration.connectUrl);
  const health = displayedSentryHealth(integration, sentryHealth);

  function startConnection() {
    if (!integration.connectUrl || isConnecting) return;
    setIsConnecting(true);
    const url = new URL(integration.connectUrl, window.location.origin);
    url.searchParams.set("returnTo", "/settings");
    window.location.assign(`${url.pathname}${url.search}`);
  }

  async function removeConnection(accountId: string, localOnly = false) {
    setRemoveError(null);
    setRemovingAccountId(accountId);
    try {
      const suffix = localOnly ? "?localOnly=true" : "";
      const response = await fetch(
        `/api/integrations/sentry/${accountId}${suffix}`,
        { method: "DELETE" },
      );
      const body = (await response.json().catch(() => null)) as {
        action?: string;
        error?: string;
        manualUninstallUrl?: string;
      } | null;
      if (
        response.status === 409 &&
        body?.action === "manual_uninstall_required" &&
        body.manualUninstallUrl
      ) {
        setManualRemoval({
          accountId,
          manualUninstallUrl: body.manualUninstallUrl,
          message: body.error ?? "Uninstall Responder in Sentry to continue.",
        });
        return;
      }
      if (!response.ok) {
        throw new Error(body?.error ?? "Unable to disconnect Sentry");
      }
      if (localOnly) {
        window.location.assign(
          "/api/integrations/sentry/start?returnTo=/settings",
        );
      } else {
        window.location.reload();
      }
    } catch (cause) {
      setRemoveError(
        cause instanceof Error ? cause.message : "Unable to disconnect Sentry",
      );
    } finally {
      setRemovingAccountId(null);
    }
  }

  return (
    <article className="integrationCard integrationCard--managed">
      <div className="integrationCard__top">
        <ProviderGlyph
          className="integrationLogo integrationLogo--sentry"
          decorative
          provider="sentry"
        />
        {health === "needs_reconnect" ? (
          <span className="connectedBadge connectedBadge--warning">Action needed</span>
        ) : health === "unavailable" ? (
          <span className="connectedBadge connectedBadge--muted">Not verified</span>
        ) : health === "checking" ? (
          <span className="connectedBadge connectedBadge--muted">Checking</span>
        ) : health === "working" ? (
          <span className="connectedBadge">Working</span>
        ) : integration.accountCount > 0 ? (
          <span className="connectedBadge">Connected</span>
        ) : null}
      </div>
      <div className="integrationCard__body">
        <strong>Sentry</strong>
        <small>{integrationDetail(integration, sentryHealth)}</small>
        {integration.accounts.length > 0 ? (
          <ul className="integrationCard__accounts" aria-label="Connected Sentry organizations">
            {integration.accounts.map((account) => (
              <li key={account.id}>
                <span>
                  <strong>{account.displayName}</strong>
                  <small>
                    {account.resourceCount} project{account.resourceCount === 1 ? "" : "s"}
                  </small>
                </span>
                <span className="integrationCard__accountStatus">
                  {account.status === "connected"
                    ? "Connected"
                    : account.status === "pending"
                      ? "Pending"
                      : "Error"}
                </span>
                <span className="integrationCard__accountActions">
                  <button
                    className="button button--secondary button--small"
                    disabled={isConnecting}
                    onClick={startConnection}
                    type="button"
                  >
                    Reconnect
                  </button>
                  <button
                    className="button button--secondary button--small"
                    disabled={removingAccountId === account.id}
                    onClick={() => {
                      if (!window.confirm(
                        `Disconnect ${account.displayName}? Responder will uninstall the app from this Sentry organization and remove its projects.`,
                      )) return;
                      setManualRemoval(null);
                      void removeConnection(account.id);
                    }}
                    type="button"
                  >
                    {removingAccountId === account.id ? "Disconnecting…" : "Disconnect"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <small className="integrationCard__hint">
            If Sentry says Responder is already installed, uninstall it from that
            Sentry organization before trying again.
          </small>
        )}
      </div>
      {manualRemoval ? (
        <div className="integrationCard__manualAction" role="alert">
          <p>{manualRemoval.message}</p>
          <div>
            <a
              className="button button--secondary button--small"
              href={manualRemoval.manualUninstallUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open Sentry settings
            </a>
            <button
              className="button button--primary button--small"
              disabled={removingAccountId === manualRemoval.accountId}
              onClick={() => void removeConnection(manualRemoval.accountId, true)}
              type="button"
            >
              I’ve uninstalled it — reconnect
            </button>
          </div>
        </div>
      ) : null}
      {removeError ? <p className="siteDialog__error">{removeError}</p> : null}
      <div className="integrationCard__actions">
        {canConnect ? (
          <button
            aria-busy={isConnecting}
            className="button button--primary button--small"
            disabled={isConnecting}
            onClick={startConnection}
            type="button"
          >
            {integration.accountCount > 0 ? "Connect organization" : "Connect Sentry"}
          </button>
        ) : (
          <small>Provider configuration required</small>
        )}
      </div>
    </article>
  );
}
