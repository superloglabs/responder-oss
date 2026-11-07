import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { IconCheck, IconSearch } from "@tabler/icons-react";
import { fetchAgentOptions, fetchIntegrations, type AgentOptions, type IntegrationSummary } from "../agents-api";
import { providerDisplayName } from "../components/provider-glyphs";
import { ScrollArea } from "../components/ui/scroll-area";
import { Button } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import {
  connectionStartUrl,
  fetchSignalSettings,
  saveSignalSettings,
  type SignalSettings,
} from "./model";
import { authClient } from "../auth-client";
import { publishSignalSettings } from "./setup-state";
import { fetchServices } from "../telemetry-api";
import { SignalConnect } from "./connect";
import { SignalManage } from "./manage";
import { manageableAccounts } from "./manage-model";
import { connectPages, type ConnectPage } from "./connect-pages";
import { SignalPlanStep } from "./plan";
import { ConnectionRow, SignalLogo } from "./shared";

interface Source { provider: string; name: string; description: string }

const telemetry: Source[] = [
  { provider: "otel", name: "OpenTelemetry", description: "Logs, traces, and metrics sent to Superlog, including CloudWatch and Google Cloud" },
  { provider: "sentry", name: providerDisplayName("sentry"), description: "Errors and issues" },
  { provider: "datadog", name: providerDisplayName("datadog"), description: "Monitors, logs, traces, and metrics" },
  { provider: "grafana", name: providerDisplayName("grafana"), description: "Dashboards, alerts, and queries" },
  { provider: "aws", name: `${providerDisplayName("aws")} CloudWatch`, description: "Logs, metrics, and resources" },
  { provider: "gcp", name: providerDisplayName("gcp"), description: "Logs, metrics, and resources" },
];
const context: Source[] = [
  { provider: "linear", name: providerDisplayName("linear"), description: "Issues, priorities, and work already in progress" },
  { provider: "jira", name: "Jira", description: "Tickets, project history, and known issues" },
  { provider: "posthog", name: providerDisplayName("posthog"), description: "Product usage and customer impact" },
];
const steps = ["telemetry", "code", "repositories", "slack", "context", "plan"] as const;
type Step = (typeof steps)[number];
const headings: Record<Step, string> = {
  telemetry: "Connect your telemetry",
  code: "Connect your GitHub organization",
  repositories: "Select your repositories",
  slack: "Connect Slack",
  context: "Add more context",
  plan: "Choose your plan",
};
const descriptions: Record<Step, string> = {
  telemetry: "Signal investigates your telemetry and sends issues with real impact to Slack.",
  code: "Connect GitHub to choose the repositories Signal can read.",
  repositories: "Signal reads these repositories to find the cause of a problem. It never changes them.",
  slack: "Choose where Signal sends findings.",
  context: "Signal skips problems already tracked in tickets, alerts, or Slack.",
  plan: "Start a monthly subscription to receive investigated findings in Slack.",
};
const stepNumber: Record<Step, number> = { telemetry: 1, code: 2, repositories: 2, slack: 3, context: 4, plan: 5 };

export function SignalSetup() {
  const { step: stepParam = "telemetry", page: pageParam, mode } = useParams();
  const step = steps.find((candidate) => candidate === stepParam);
  const page = connectPages.find((candidate) => candidate === pageParam);
  const [searchParams, setSearchParams] = useSearchParams();
  useDocumentTitle("Signal · Setup");
  const navigate = useNavigate();
  const organizationId = authClient.useSession().data?.session.activeOrganizationId;
  const [integrations, setIntegrations] = useState<IntegrationSummary[] | null>(null);
  const [options, setOptions] = useState<AgentOptions | null>(null);
  const [settings, setSettings] = useState<SignalSettings | null>(null);
  const [draft, setDraft] = useState<SignalSettings | null>(null);
  const [search, setSearch] = useState("");
  // How many services sent OpenTelemetry data in the last day, once known.
  const [otelServices, setOtelServices] = useState<number | null>(null);
  // A failed lookup is not the same as no data: the manage page shows it.
  const [otelLookupFailed, setOtelLookupFailed] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Bumped by "Try again"; each load records the attempt it belongs to.
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState<{ attempt: number; message: string } | null>(null);
  useEffect(() => {
    let current = true;
    Promise.all([fetchIntegrations(), fetchAgentOptions(), fetchSignalSettings()])
      .then(([loadedIntegrations, loadedOptions, loadedSettings]) => {
        if (!current) return;
        setIntegrations(loadedIntegrations);
        setOptions(loadedOptions);
        setSettings(loadedSettings);
        setDraft(loadedSettings);
        if (organizationId) publishSignalSettings(organizationId, loadedSettings);
      })
      .catch((failure: unknown) => {
        if (current) setLoadError({ attempt, message: failure instanceof Error ? failure.message : "Could not load setup." });
      });
    return () => { current = false; };
  }, [attempt, organizationId]);

  useEffect(() => {
    // The OpenTelemetry page needs them too, under any step.
    if (step !== "telemetry" && page !== "otel") return;
    let current = true;
    const until = Date.now();
    fetchServices({ since: until - 86_400_000, until }, "all")
      .then((services) => {
        if (!current) return;
        setOtelServices(services?.length ?? 0);
        setOtelLookupFailed(false);
      })
      .catch(() => {
        if (!current) return;
        setOtelServices(0);
        setOtelLookupFailed(true);
      });
    return () => { current = false; };
  }, [step, page]);

  const channels = (options?.resources ?? [])
    .filter((resource) => resource.kind === "slack_channel")
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  if (!step || (pageParam && (!page || !["telemetry", "context"].includes(step))) || (mode && (!page || mode !== "connect"))) {
    return <Navigate replace to="/signal/setup" />;
  }
  if (!integrations || !options || !draft || !settings) {
    return loadError?.attempt === attempt
      ? <section className="signalEmpty"><p className="signalError" role="alert">{loadError.message}</p><Button onClick={() => setAttempt(attempt + 1)}>Try again</Button></section>
      : <p className="signalLoading" role="status">Loading…</p>;
  }

  const returnTo = `/signal/setup/${step}`;
  const summary = (provider: string) => integrations.find((integration) => integration.id === provider);
  const connected = (provider: string) => provider === "otel" ? Boolean(otelServices) : summary(provider)?.state === "connected";
  const index = steps.indexOf(step);
  const go = (target: Step) => navigate(`/signal/setup/${target}`);

  function connect(provider: string) {
    if (connectPages.includes(provider as ConnectPage)) { navigate(`${returnTo}/${provider}`); return; }
    const connectUrl = summary(provider)?.connectUrl;
    if (!connectUrl) return;
    window.location.assign(connectionStartUrl(connectUrl, returnTo));
  }

  async function save(next: SignalSettings, then?: Step | "findings") {
    setSaving(true);
    setError("");
    try {
      const saved = await saveSignalSettings(next);
      setSettings(saved);
      setDraft(saved);
      if (organizationId) publishSignalSettings(organizationId, saved);
      if (then === "findings") navigate("/signal/findings");
      else if (then) go(then);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  function rows(sources: Source[]) {
    return <div className="signalConnections signalConnections--compact">{sources.map((source) => {
      const integration = summary(source.provider);
      const unavailable = source.provider === "jira" || (!["otel", "gcp"].includes(source.provider) && !integration?.connectUrl && !connected(source.provider));
      return <ConnectionRow key={source.provider}
        provider={source.provider}
        name={source.name}
        description={source.provider === "jira" ? "Coming soon"
          : source.provider === "otel" && otelServices ? `${otelServices} ${otelServices === 1 ? "service" : "services"} sending data`
          : source.description}
        connected={connected(source.provider)}
        disabled={unavailable}
        onConnect={() => connect(source.provider)}
        onManage={() => connectPages.includes(source.provider as ConnectPage) ? navigate(`${returnTo}/${source.provider}`) : navigate("/settings")} />;
    })}</div>;
  }

  const repositories = options.repositories
    .filter((repository) => repository.fullName.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  // A provider's own site sends people back here with the outcome.
  const failedProvider = searchParams.get("status") === "error" ? searchParams.get("integration") : null;
  const failedName = failedProvider ? [...telemetry, ...context].find((source) => source.provider === failedProvider)?.name ?? providerDisplayName(failedProvider) : null;

  if (page) {
    // A connected source opens on its manage page; "connect" opens the form
    // again, to replace keys or sign in again.
    if (page === "otel" && mode !== "connect" && otelServices === null) return <p className="signalLoading" role="status">Loading…</p>;
    const managed = mode !== "connect" && (page === "otel" ? Boolean(otelServices) || otelLookupFailed : manageableAccounts(summary(page)?.accounts).length > 0);
    const pagePath = `${returnTo}/${page}`;
    return <section className="signalSetup">
      <header className="signalWelcome"><h1>Welcome to Signal</h1><p>Step {stepNumber[step]} out of 5</p></header>
      {managed ? <SignalManage page={page}
        name={[...telemetry, ...context].find((source) => source.provider === page)?.name ?? providerDisplayName(page)}
        integration={summary(page)}
        onBack={() => navigate(returnTo)}
        onReconnect={() => navigate(`${pagePath}/connect`)}
        onOpenIngestKeys={() => navigate("/settings/ingest-keys")}
        onRemoved={() => {
          // Shows loading, or the load error, instead of the removed account.
          setIntegrations(null);
          setAttempt(attempt + 1);
          navigate(returnTo);
        }} />
      : <SignalConnect page={page}
        integration={summary(page)}
        organizationId={organizationId ?? undefined}
        listPath={returnTo}
        onBack={() => navigate(returnTo)}
        onDone={() => {
          // The connection may be new, so load the list again.
          setAttempt(attempt + 1);
          navigate(returnTo);
        }} />}
    </section>;
  }

  return <section className={`signalSetup${step === "repositories" ? " signalSetup--repositories" : ""}`}>
    <header className="signalWelcome"><h1>Welcome to Signal</h1><p>Step {stepNumber[step]} out of 5</p></header>
    <div className="signalIntro"><h2>{headings[step]}</h2><p>{descriptions[step]}</p></div>
    {error && <p className="signalError" role="alert">{error}</p>}
    {failedName && <p className="signalError" role="alert">
      Could not connect {failedName}. Try again{searchParams.get("reason") ? ` (${searchParams.get("reason")})` : ""}.{" "}
      <button type="button" className="signalLinkButton" onClick={() => setSearchParams({}, { replace: true })}>Dismiss</button>
    </p>}

    {step === "telemetry" && rows(telemetry)}

    {step === "repositories" && <div className="signalRepositories">
      <div className="signalRepoSearch">
        <label className="signalSearch"><IconSearch size={14} /><input aria-label="Search repositories" placeholder="Search repositories…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <span>{draft.repositoryIds.length} selected</span>
      </div>
      <ScrollArea className="signalRepoList">
        {repositories.map((repository) => <label className="signalRepoRow" key={repository.id}>
          <span className="signalRepoCheckbox">
            <input type="checkbox" checked={draft.repositoryIds.includes(repository.id)} onChange={(e) => setDraft({
              ...draft,
              repositoryIds: e.target.checked
                ? [...draft.repositoryIds, repository.id]
                : draft.repositoryIds.filter((id) => id !== repository.id),
            })} />
            <IconCheck aria-hidden="true" size={12} />
          </span>
          <span>{repository.fullName.replace("/", " / ")}</span>
        </label>)}
        {options.repositories.length === 0 && <p className="signalEmpty"><Link to="/signal/setup/code">Connect GitHub</Link> to select repositories.</p>}
        {options.repositories.length > 0 && repositories.length === 0 && <p className="signalEmpty">No repositories match “{search}”.</p>}
      </ScrollArea>
    </div>}

    {step === "slack" && <div className="signalConnections signalSlack">
      <ConnectionRow provider="slack" name={providerDisplayName("slack")}
        description={connected("slack") ? summary("slack")?.accounts?.[0]?.displayName ?? "Connected" : "Connect your workspace"}
        connected={connected("slack")} onConnect={() => connect("slack")} onManage={() => navigate("/settings")} />
      <div className="signalSlackFields"><div className="signalField">
        <label htmlFor="signal-findings-channel"><strong>Findings channel</strong><span>Issues that need your attention.</span></label>
        <select id="signal-findings-channel" aria-label="Findings channel" disabled={channels.length === 0}
          value={draft.slack?.channelId ?? ""}
          onChange={(e) => {
            const channel = channels.find((candidate) => candidate.externalId === e.target.value);
            setDraft({ ...draft, slack: channel ? { integrationAccountId: channel.integrationAccountId, channelId: channel.externalId } : null });
          }}>
          <option value="">Choose a channel</option>
          {channels.map((channel) => <option key={channel.id} value={channel.externalId}># {channel.displayName.replace(/^#/u, "")}</option>)}
        </select>
      </div></div>
    </div>}

    {step === "context" && rows(context)}

    {step === "plan" && <SignalPlanStep settings={settings} slackChosen={Boolean(draft.slack)} saving={saving}
      onBack={() => go("context")}
      onTurnOn={() => save({ ...draft, enabled: true }, "findings")}
      onTurnOff={() => save({ ...draft, enabled: false })} />}

    {step !== "plan" && <footer className={`signalSetupActions${step === "code" ? " signalSetupActions--inline" : ""}`}>
      {index > 0 ? <Button onClick={() => go(steps[index - 1]!)}>Back</Button> : <span />}
      {step === "code" && !connected("github")
        // Without GitHub, Signal explains problems from telemetry alone.
        ? <div className="signalSetupChoice">
          <Button onClick={() => go("slack")}>Skip for now</Button>
          <Button className="signalGithubButton" variant="primary" disabled={!summary("github")?.connectUrl} onClick={() => connect("github")}><SignalLogo provider="github" />Connect GitHub</Button>
        </div>
        : step === "repositories" ? <Button variant={draft.repositoryIds.length ? "primary" : "secondary"} disabled={saving} onClick={() => void save(draft, "slack")}>
          {draft.repositoryIds.length ? "Continue" : "Skip for now"}
        </Button>
        : step === "slack" ? <Button variant="primary" disabled={saving || !draft.slack} onClick={() => void save(draft, "context")}>Continue</Button>
        : <Button variant={step === "context" ? "secondary" : "primary"} onClick={() => go(steps[index + 1]!)}>
          {step === "context" && !context.some((source) => connected(source.provider)) ? "Skip for now" : "Continue"}
        </Button>}
    </footer>}

  </section>;
}
