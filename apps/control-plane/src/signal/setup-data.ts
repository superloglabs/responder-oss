import { useEffect, useState } from "react";
import { fetchAgentOptions, fetchIntegrations, type AgentOptions, type IntegrationSummary } from "../agents-api";
import { providerDisplayName } from "../components/provider-glyphs";
import { fetchServices } from "../telemetry-api";
import { connectPages, type ConnectPage } from "./connect-pages";
import { manageableAccounts } from "./manage-model";
import { connectionStartUrl, fetchSignalSettings, type SignalSettings } from "./model";
import { publishSignalSettings } from "./setup-state";

export interface Source { provider: string; name: string; description: string }

export const telemetrySources: Source[] = [
  { provider: "otel", name: "OpenTelemetry", description: "Logs, traces, and metrics sent to Superlog, including CloudWatch and Google Cloud" },
  { provider: "sentry", name: providerDisplayName("sentry"), description: "Errors and issues" },
  { provider: "datadog", name: providerDisplayName("datadog"), description: "Monitors, logs, traces, and metrics" },
  { provider: "grafana", name: providerDisplayName("grafana"), description: "Dashboards, alerts, and queries" },
  { provider: "aws", name: `${providerDisplayName("aws")} CloudWatch`, description: "Logs, metrics, and resources" },
  { provider: "gcp", name: providerDisplayName("gcp"), description: "Logs, metrics, and resources" },
];

export const contextSources: Source[] = [
  { provider: "linear", name: providerDisplayName("linear"), description: "Issues, priorities, and work already in progress" },
  { provider: "jira", name: "Jira", description: "Tickets, project history, and known issues" },
  { provider: "posthog", name: providerDisplayName("posthog"), description: "Product usage and customer impact" },
];

export function sourceName(provider: string) {
  return [...telemetrySources, ...contextSources].find((source) => source.provider === provider)?.name ?? providerDisplayName(provider);
}

export function isConnectPage(value: string | undefined): value is ConnectPage {
  return connectPages.includes(value as ConnectPage);
}

export interface SetupData {
  integrations: IntegrationSummary[];
  options: AgentOptions;
  settings: SignalSettings;
}

// Loads what setup and its settings pages show, and publishes the settings
// so the sidebar knows whether setup is complete.
export function useSetupData(organizationId: string | null | undefined) {
  const [data, setData] = useState<SetupData | null>(null);
  // Bumped by "Try again"; each load records the attempt it belongs to.
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState<{ attempt: number; message: string } | null>(null);
  useEffect(() => {
    let current = true;
    Promise.all([fetchIntegrations(), fetchAgentOptions(), fetchSignalSettings()])
      .then(([integrations, options, settings]) => {
        if (!current) return;
        setData({ integrations, options, settings });
        if (organizationId) publishSignalSettings(organizationId, settings);
      })
      .catch((failure: unknown) => {
        if (current) setLoadError({ attempt, message: failure instanceof Error ? failure.message : "Could not load setup." });
      });
    return () => { current = false; };
  }, [attempt, organizationId]);

  return {
    data,
    error: loadError?.attempt === attempt ? loadError.message : null,
    // Loads again. With `clear`, pages show loading until it lands.
    reload(clear = false) {
      if (clear) setData(null);
      setAttempt((value) => value + 1);
    },
    // Settings changed on the page; `saved` ones also update the sidebar.
    setSettings(settings: SignalSettings, saved = false) {
      setData((previous) => previous && { ...previous, settings });
      if (saved && organizationId) publishSignalSettings(organizationId, settings);
    },
  };
}

// How many services sent OpenTelemetry data in the last day, once known. A
// failed lookup is not the same as no data: the manage page shows it. Loads
// again whenever `key` changes, and not at all while it is null.
export function useOtelServices(key: string | null) {
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (key === null) return;
    let current = true;
    const until = Date.now();
    fetchServices({ since: until - 86_400_000, until }, "all")
      .then((services) => {
        if (!current) return;
        setCount(services?.length ?? 0);
        setFailed(false);
      })
      .catch(() => {
        if (!current) return;
        setCount(0);
        setFailed(true);
      });
    return () => { current = false; };
  }, [key]);
  return { count, failed };
}

// Connecting and managing sources from a list at `listPath`. Integrations
// with a page of their own open it under the list; the others start OAuth
// and come back to the list.
export function sourceActions(input: {
  integrations: IntegrationSummary[];
  otelServices: number | null;
  // With a failed services lookup, OpenTelemetry counts as connected, so its
  // manage page can show the failure.
  otelFailed?: boolean;
  listPath: string;
  navigate: (path: string) => void;
}) {
  const { integrations, otelServices, otelFailed = false, listPath, navigate } = input;
  const summary = (provider: string) => integrations.find((integration) => integration.id === provider);
  const connected = (provider: string) => provider === "otel" ? Boolean(otelServices) || otelFailed : summary(provider)?.state === "connected";
  return {
    listPath,
    summary,
    connected,
    accounts: (provider: string) => manageableAccounts(summary(provider)?.accounts),
    unavailable: (provider: string) => provider === "jira" ||
      (!["otel", "gcp"].includes(provider) && !summary(provider)?.connectUrl && !connected(provider)),
    connect(provider: string) {
      if (isConnectPage(provider)) { navigate(`${listPath}/${provider}`); return; }
      const connectUrl = summary(provider)?.connectUrl;
      if (connectUrl) window.location.assign(connectionStartUrl(connectUrl, listPath));
    },
    manage(provider: string) {
      navigate(isConnectPage(provider) ? `${listPath}/${provider}` : "/settings");
    },
  };
}

export type SourceActions = ReturnType<typeof sourceActions>;

export function slackChannels(options: AgentOptions) {
  return options.resources
    .filter((resource) => resource.kind === "slack_channel")
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
