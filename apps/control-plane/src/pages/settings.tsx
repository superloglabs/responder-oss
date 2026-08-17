import { useEffect, useState } from "react";
import { AppShell } from "../components/app-shell";
import {
  DatadogConnectionDialog,
} from "../components/datadog-site-dialog";
import { ClickStackConnectionDialog } from "../components/clickstack-connection-dialog";
import { AwsConnectionDialog } from "../components/aws-connection-dialog";
import { CustomMcpConnectionDialog } from "../components/custom-mcp-dialog";
import { UpstashConnectionDialog } from "../components/upstash-connection-dialog";
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
    | "github"
    | "slack"
    | "sentry"
    | "datadog"
    | "upstash"
    | "vercel"
    | "custom_mcp"
    | "clickstack"
    | "linear";
  name: string;
  description: string;
  state: IntegrationState;
  accountCount: number;
  resourceCount: number;
  connectUrl: string | null;
  configurationUrl: string | null;
}

interface IntegrationResponse {
  integrations: IntegrationSummary[];
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
        : "The connection could not be completed.";
  return { tone: "error", message: `${name}: ${detail}` };
}

export function SettingsPage() {
  useDocumentTitle("Settings");
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notice] = useState(connectionNotice);
  const isFinishingSentryConnection =
    new URLSearchParams(window.location.search).get("integration") === "sentry" &&
    new URLSearchParams(window.location.search).get("status") === "finishing";

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    let retryCount = 0;

    function loadIntegrations() {
      void fetch("/api/integrations")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load integrations");
        return (await response.json()) as IntegrationResponse;
      })
      .then((response) => {
        if (!active) return;
        setIntegrations(response.integrations);
        const sentryConnected = response.integrations.some(
          (integration) =>
            integration.id === "sentry" && integration.state === "connected",
        );
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
    };
  }, [isFinishingSentryConnection]);

  const featured = integrations.filter((integration) =>
    ["github", "slack"].includes(integration.id),
  );
  const secondary = integrations.filter((integration) =>
    [
      "aws",
      "sentry",
      "datadog",
      "upstash",
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
                <IntegrationCard integration={integration} key={integration.id} />
              ))}
            </div>
            <div className="integrationRow">
              {secondary.map((integration) => (
                <IntegrationCard integration={integration} key={integration.id} />
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

function integrationDetail(integration: IntegrationSummary): string {
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

function IntegrationCard({ integration }: { integration: IntegrationSummary }) {
  const actionUrl = integrationActionUrl(integration);
  const canConnect = Boolean(actionUrl);
  const [isConnecting, setIsConnecting] = useState(false);
  const [choosingDatadogSite, setChoosingDatadogSite] = useState(false);
  const [configuringCustomMcp, setConfiguringCustomMcp] = useState(false);
  const [connectingUpstash, setConnectingUpstash] = useState(false);
  const [connectingClickStack, setConnectingClickStack] = useState(false);
  const [connectingAws, setConnectingAws] = useState(false);

  function startConnection() {
    if (!actionUrl || isConnecting) return;
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
          {integration.state === "connected" ? (
            <span className="connectedBadge">Connected</span>
          ) : integration.state === "coming_soon" ? (
            <span className="connectedBadge connectedBadge--muted">Coming next</span>
          ) : null}
        </span>
        <span className="integrationCard__body">
          <strong>{integration.name}</strong>
          <small>{integrationDetail(integration)}</small>
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
