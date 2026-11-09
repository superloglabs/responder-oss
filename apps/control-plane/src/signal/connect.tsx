import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  IconAlertCircle,
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconX,
} from "@tabler/icons-react";
import type { IntegrationSummary } from "../agents-api";
import { DATADOG_SITES, type DatadogSiteId } from "../components/datadog-sites";
import { AwsLogStreamingSettings } from "../components/aws-log-streaming";
import { Button } from "../design-system";
import { GCP_SETUP_STEPS, useGcpSetupStatus, type GcpSetupStatus } from "../gcp-setup-status";
import { createIngestKey, existingOpenTelemetryPrompt, openTelemetryPrompt } from "../ingest-keys-api";
import { currentProjectSelectionState } from "../project-selection";
import { fetchServices } from "../telemetry-api";
import type { ConnectPage } from "./connect-pages";
import { connectionStartUrl } from "./model";
import { SignalLogo } from "./shared";


interface PageProps {
  integration: IntegrationSummary | undefined;
  organizationId: string | undefined;
  // The setup list this page belongs to, e.g. "/signal/setup/telemetry".
  listPath: string;
  onBack: () => void;
  onDone: () => void;
}

export function SignalConnect({ page, ...props }: PageProps & { page: ConnectPage }) {
  switch (page) {
    case "otel": return <OpenTelemetryConnect {...props} />;
    case "grafana": return <GrafanaConnect {...props} />;
    case "datadog": return <DatadogConnect {...props} />;
    case "aws": return <AwsConnect {...props} />;
    case "gcp": return <GcpConnect {...props} />;
    default: return <OAuthApproval page={page} {...props} />;
  }
}

export function Intro({ provider, title, children }: { provider: string; title: string; children: ReactNode }) {
  return <div className="signalIntro">
    <h2 className="signalConnectTitle"><span className="signalTitleLogo"><SignalLogo provider={provider} /></span>{title}</h2>
    <p>{children}</p>
  </div>;
}

export function Actions({ onBack, children }: { onBack: () => void; children?: ReactNode }) {
  return <footer className="signalSetupActions">
    <Button onClick={onBack}>Back</Button>
    {children}
  </footer>;
}

function External({ children }: { children: ReactNode }) {
  return <>{children}<IconArrowUpRight aria-hidden="true" size={14} /></>;
}

function AccessList({ title, allowed, denied }: { title: string; allowed: string[]; denied: string }) {
  return <section className="signalAccess">
    <h3>{title}</h3>
    <ul>
      {allowed.map((item) => <li key={item}><IconCheck aria-hidden="true" className="signalAccess__yes" size={14} />{item}</li>)}
      <li className="signalAccess__no"><IconX aria-hidden="true" size={14} />{denied}</li>
    </ul>
  </section>;
}

function StepMarker({ state, number }: { state: "done" | "current" | "pending" | "failed"; number: number }) {
  if (state === "done") return <span className="signalStepMarker signalStepMarker--done"><IconCheck aria-label="Done" size={11} stroke={3} /></span>;
  if (state === "current") return <span className="signalStepMarker signalStepMarker--current" aria-label="In progress" />;
  if (state === "failed") return <span className="signalStepMarker signalStepMarker--failed"><IconX aria-label="Failed" size={11} stroke={3} /></span>;
  return <span className="signalStepMarker">{number}</span>;
}

function errorMessage(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback;
}

async function postJson(url: string, body: unknown, fallback: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof parsed?.error === "string" ? parsed.error : fallback);
  return parsed ?? {};
}

// --- OpenTelemetry ---------------------------------------------------------

interface ServiceRow { name: string; logs: boolean; traces: boolean; metrics: boolean }

// Services that sent anything in the last 15 minutes, checked every 5 seconds.
function useRecentServices(): ServiceRow[] {
  const [rows, setRows] = useState<ServiceRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const until = Date.now();
      const range = { since: until - 15 * 60_000, until };
      const [logs = [], traces = [], metrics = []] = await Promise.all(
        (["logs", "traces", "metrics"] as const).map(async (signal) => (await fetchServices(range, signal).catch(() => null)) ?? []),
      );
      if (cancelled) return;
      const names = [...new Set([...logs, ...traces, ...metrics])].sort();
      setRows(names.map((name) => ({ name, logs: logs.includes(name), traces: traces.includes(name), metrics: metrics.includes(name) })));
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  return rows;
}

// One key per browser session, so going back and forth does not pile up keys.
function useSetupIngestKey(organizationId: string | undefined) {
  const storageKey = organizationId ? `signal-setup-ingest-key:${organizationId}` : null;
  const saved = storageKey ? sessionStorage.getItem(storageKey) : null;
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState("");
  const requested = useRef(false);
  useEffect(() => {
    if (!storageKey || saved || requested.current) return;
    requested.current = true;
    createIngestKey({ name: "Signal setup" })
      .then(({ token }) => {
        sessionStorage.setItem(storageKey, token);
        setCreated(token);
      })
      .catch((failure: unknown) => setError(errorMessage(failure, "Could not create an ingest key.")));
  }, [saved, storageKey]);
  return { token: created ?? saved, error };
}

function OpenTelemetryConnect({ organizationId, onBack, onDone }: PageProps) {
  const [existing, setExisting] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const { token, error } = useSetupIngestKey(organizationId);
  const services = useRecentServices();
  const receiving = services.length > 0;
  const prompt = (existing ? existingOpenTelemetryPrompt : openTelemetryPrompt)(window.location.origin, token ?? undefined);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyFailed(true);
    }
  }

  return <>
    <Intro provider="otel" title="Connect OpenTelemetry">Paste this prompt into your coding agent. It sends your logs, traces, and metrics to Superlog.</Intro>
    {error && <p className="signalError" role="alert">{error}</p>}
    {copyFailed && <p className="signalError" role="alert">Could not copy the prompt. Select it below and copy it yourself.</p>}
    <div className="signalChoice">
      <span id="signal-otel-existing">Do you already use OpenTelemetry?</span>
      <div className="signalSegmented" role="radiogroup" aria-labelledby="signal-otel-existing">
        <button type="button" role="radio" aria-checked={existing} onClick={() => setExisting(true)}>Yes</button>
        <button type="button" role="radio" aria-checked={!existing} onClick={() => setExisting(false)}>No, or I don't know</button>
      </div>
    </div>
    <section className="signalCard">
      <header className="signalCard__header">
        <div>
          <h3>{existing ? "Add Superlog to your existing setup" : "Set up OpenTelemetry and send data to Superlog"}</h3>
          <p>{existing ? "Keeps your current exporters. Adds Superlog as one more destination." : "Instruments each service for logs, traces, and metrics."}</p>
        </div>
        {receiving
          ? <Button aria-expanded={promptOpen} onClick={() => setPromptOpen(!promptOpen)}>
            {promptOpen ? "Hide prompt" : "Show prompt"}{promptOpen ? <IconChevronUp aria-hidden="true" size={14} /> : <IconChevronDown aria-hidden="true" size={14} />}
          </Button>
          : <Button variant="primary" disabled={!token} onClick={() => void copy()}><IconCopy aria-hidden="true" size={14} />{copied ? "Copied" : "Copy prompt"}</Button>}
      </header>
      {(!receiving || promptOpen) && <pre className="signalPromptBody">{prompt}</pre>}
      {receiving && <table className="signalServices">
        <thead><tr><th>Service</th><th>Logs</th><th>Traces</th><th>Metrics</th></tr></thead>
        <tbody>{services.map((service) => <tr key={service.name}>
          <td>{service.name}</td>
          {([service.logs, service.traces, service.metrics]).map((sent, index) => <td key={index}>
            {sent ? <IconCheck aria-label="Receiving" size={14} /> : <span aria-label="None">—</span>}
          </td>)}
        </tr>)}</tbody>
      </table>}
      <footer className="signalCard__footer">
        <span>{receiving
          ? `${services.length} ${services.length === 1 ? "service" : "services"} sent data in the last 15 minutes.`
          : "Includes a new ingest key, “Signal setup”. It can only send data. Manage it in Settings."}</span>
        {receiving
          ? <span className="signalConnected"><IconCheck size={14} />Receiving data</span>
          : <span className="signalWaiting"><i aria-hidden="true" />Waiting for data</span>}
      </footer>
    </section>
    <Actions onBack={onBack}><Button variant="primary" disabled={!receiving} onClick={onDone}>Continue</Button></Actions>
  </>;
}

// --- Grafana ---------------------------------------------------------------

function GrafanaConnect({ integration, listPath, onBack }: PageProps) {
  const [deployment, setDeployment] = useState<"cloud" | "self_hosted">("cloud");
  const [stackUrl, setStackUrl] = useState("");
  const [grafanaUrl, setGrafanaUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const cloud = deployment === "cloud";

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!integration?.connectUrl || submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const body = await postJson(integration.connectUrl, cloud
        ? { deployment, returnTo: listPath, stackUrl }
        : { deployment, grafanaUrl, returnTo: listPath, serviceAccountToken: token }, "Unable to connect Grafana");
      if (typeof body.redirectUrl !== "string") throw new Error("Unable to connect Grafana");
      window.location.assign(body.redirectUrl);
    } catch (failure) {
      setError(errorMessage(failure, "Unable to connect Grafana"));
      setSubmitting(false);
    }
  }

  return <form className="signalConnectForm" onSubmit={(event) => void connect(event)}>
    <Intro provider="grafana" title="Connect Grafana">Signal reads your dashboards, alerts, and datasources. It never changes anything in Grafana.</Intro>
    <fieldset className="signalFieldset">
      <legend>Deployment</legend>
      <div className="signalOptions">
        <label className="signalOption">
          <input type="radio" name="grafana-deployment" checked={cloud} onChange={() => { setDeployment("cloud"); setError(""); }} />
          <span><strong>Grafana Cloud</strong><small>Sign in with Grafana. No token to copy.</small></span>
        </label>
        <label className="signalOption">
          <input type="radio" name="grafana-deployment" checked={!cloud} onChange={() => { setDeployment("self_hosted"); setError(""); }} />
          <span><strong>Self-hosted</strong><small>Use a URL and a service account token.</small></span>
        </label>
      </div>
      {!cloud && <ol className="signalInstructions">
        <li>In Grafana, open <strong>Administration → Users and access → Service accounts</strong>.</li>
        <li>Add a service account with the <strong>Viewer</strong> role, then add a token to it.</li>
        <li>Paste the URL and token below. The URL must be reachable over public HTTPS.</li>
      </ol>}
    </fieldset>
    {cloud
      ? <div className="signalInput">
        <label htmlFor="signal-grafana-stack">Stack URL</label>
        <input id="signal-grafana-stack" autoComplete="off" spellCheck={false} placeholder="https://your-stack.grafana.net" required value={stackUrl} onChange={(e) => setStackUrl(e.target.value)} />
        {error ? <p className="signalFieldError" role="alert"><IconAlertCircle size={14} />{error}</p>
          : <p>Your stack name or any URL on it. For example, acme or acme.grafana.net.</p>}
      </div>
      : <>
        <div className="signalInput">
          <label htmlFor="signal-grafana-url">Grafana URL</label>
          <input id="signal-grafana-url" type="url" spellCheck={false} placeholder="https://grafana.example.com" required value={grafanaUrl} onChange={(e) => setGrafanaUrl(e.target.value)} />
        </div>
        <div className={`signalInput${error ? " signalInput--error" : ""}`}>
          <label htmlFor="signal-grafana-token">Service account token</label>
          <div className="signalSecret">
            <input id="signal-grafana-token" type={showToken ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder="glsa_…" required value={token} onChange={(e) => setToken(e.target.value)} />
            <button type="button" aria-label={showToken ? "Hide token" : "Show token"} onClick={() => setShowToken(!showToken)}>{showToken ? <IconEyeOff size={14} /> : <IconEye size={14} />}</button>
          </div>
          {error ? <p className="signalFieldError" role="alert"><IconAlertCircle size={14} />{error}</p>
            : <p>Stored encrypted. Signal uses it only to read and query.</p>}
        </div>
      </>}
    {cloud && <AccessList title="Access Signal requests"
      allowed={["Read dashboards, alert rules, and annotations", "Query datasources such as Prometheus, Loki, and Tempo"]}
      denied="No write access to dashboards, alerts, or incidents" />}
    <Actions onBack={onBack}>
      <Button type="submit" variant="primary" loading={submitting} disabled={!integration?.connectUrl || (cloud ? !stackUrl.trim() : !grafanaUrl.trim() || !token.trim())}>
        {cloud ? <External>Continue with Grafana Cloud</External> : "Connect Grafana"}
      </Button>
    </Actions>
  </form>;
}

// --- Datadog ---------------------------------------------------------------

function DatadogConnect({ integration, listPath, onBack }: PageProps) {
  const [site, setSite] = useState<DatadogSiteId>("datadoghq.com");
  const [apiKey, setApiKey] = useState("");
  const [applicationKey, setApplicationKey] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const selected = DATADOG_SITES.find((candidate) => candidate.id === site)!;

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!integration?.connectUrl || submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const body = await postJson(integration.connectUrl, { apiKey, applicationKey, returnTo: listPath, site }, "Unable to connect Datadog");
      if (typeof body.redirectUrl !== "string") throw new Error("Unable to connect Datadog");
      window.location.assign(body.redirectUrl);
    } catch (failure) {
      setError(errorMessage(failure, "Unable to connect Datadog"));
      setSubmitting(false);
    }
  }

  return <form className="signalConnectForm" onSubmit={(event) => void connect(event)}>
    <Intro provider="datadog" title="Connect Datadog">Signal reads your monitors, logs, traces, and metrics. It never changes anything in Datadog.</Intro>
    <div className="signalInput">
      <label htmlFor="signal-datadog-site">Datadog site</label>
      <select id="signal-datadog-site" value={site} onChange={(e) => setSite(e.target.value as DatadogSiteId)}>
        {DATADOG_SITES.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.appUrl.replace("https://", "")}</option>)}
      </select>
      <ol className="signalInstructions">
        <li>Open <a href={`${selected.appUrl}/organization-settings/api-keys`} target="_blank" rel="noreferrer">API Keys</a> in Datadog and create or copy a key.</li>
        <li>Open <a href={`${selected.appUrl}/organization-settings/application-keys`} target="_blank" rel="noreferrer">Application Keys</a> and create a scoped key owned by you or a service account.</li>
        <li>Paste both keys below. Datadog shows the application key only once.</li>
      </ol>
    </div>
    <div className="signalInput">
      <label htmlFor="signal-datadog-api-key">API key</label>
      <input id="signal-datadog-api-key" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your Datadog API key" required value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
    </div>
    <div className={`signalInput${error ? " signalInput--error" : ""}`}>
      <label htmlFor="signal-datadog-app-key">Application key</label>
      <input id="signal-datadog-app-key" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your Datadog application key" required value={applicationKey} onChange={(e) => setApplicationKey(e.target.value)} />
      {error ? <p className="signalFieldError" role="alert"><IconAlertCircle size={14} />{error}</p>
        : <p>Stored encrypted. Signal uses the keys only to read.</p>}
    </div>
    <Actions onBack={onBack}>
      <Button type="submit" variant="primary" loading={submitting} disabled={!integration?.connectUrl || !apiKey.trim() || !applicationKey.trim()}>Connect Datadog</Button>
    </Actions>
  </form>;
}

// --- Providers approved on their own site -----------------------------------

const approvals: Record<"sentry" | "linear" | "posthog", { name: string; description: string; allowed: string[]; denied: string }> = {
  sentry: {
    name: "Sentry",
    description: "Signal reads your errors and issues to find what broke and who it affects.",
    allowed: ["Read issues, events, and stack traces", "Read projects, releases, and environments"],
    denied: "Never changes issues, alerts, or settings",
  },
  linear: {
    name: "Linear",
    description: "Signal checks Linear before posting, so it skips problems your team already tracks.",
    allowed: ["Read issues, projects, and cycles", "Read teams, labels, and priorities"],
    denied: "Never creates or changes issues",
  },
  posthog: {
    name: "PostHog",
    description: "Signal uses product usage to tell how many customers a problem affects.",
    allowed: ["Read insights, dashboards, and events", "Read logs, errors, and session replays"],
    denied: "Read-only access. Nothing in PostHog can be changed",
  },
};

function OAuthApproval({ page, integration, listPath, onBack }: PageProps & { page: ConnectPage }) {
  const approval = approvals[page as keyof typeof approvals];
  const [leaving, setLeaving] = useState(false);
  if (!approval) return null;
  return <>
    <Intro provider={page} title={`Connect ${approval.name}`}>{approval.description}</Intro>
    <AccessList title="What Signal does" allowed={approval.allowed} denied={approval.denied} />
    <Actions onBack={onBack}>
      {/* PostHog starts read-only when no access mode is given. */}
      <Button variant="primary" loading={leaving} disabled={!integration?.connectUrl} onClick={() => {
        setLeaving(true);
        window.location.assign(connectionStartUrl(integration!.connectUrl!, listPath));
      }}><External>Continue to {approval.name}</External></Button>
    </Actions>
  </>;
}

// --- AWS -------------------------------------------------------------------

interface AwsSetupState { status: "waiting" | "verifying" | "connected"; awsAccountId?: string; integrationAccountId?: string; roleArn?: string }

function awsEndpoint(connectUrl: string, path: string) {
  return connectUrl.replace(/\/connect(?:\?.*)?$/u, path);
}

function AwsConnect({ integration, organizationId, listPath, onBack, onDone }: PageProps) {
  const storageKey = `signal-aws-setup:${organizationId ?? ""}`;
  const [setupId, setSetupId] = useState<string | null>(() => sessionStorage.getItem(storageKey));
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [state, setState] = useState<AwsSetupState>({ status: "waiting" });
  const [error, setError] = useState("");
  const [launching, setLaunching] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const connectUrl = integration?.connectUrl;

  useEffect(() => {
    if (!setupId || !connectUrl || state.status === "connected") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(awsEndpoint(connectUrl, `/setup/${encodeURIComponent(setupId)}`));
        if (cancelled) return;
        if (response.status === 404) {
          sessionStorage.removeItem(storageKey);
          setSetupId(null);
          setPollFailed(false);
          return;
        }
        const body = (await response.json().catch(() => null)) as AwsSetupState | null;
        setPollFailed(!response.ok || !body?.status);
        if (response.ok && body?.status) setState(body);
      } catch {
        // The next tick tries again; say so if it keeps failing.
        if (!cancelled) setPollFailed(true);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [connectUrl, setupId, state.status, storageKey]);

  async function launch() {
    if (!connectUrl || launching) return;
    setError("");
    setPollFailed(false);
    setLaunching(true);
    // Opened before the request so the browser does not block it as a pop-up.
    const tab = window.open("about:blank", "_blank");
    try {
      const body = await postJson(connectUrl, { returnTo: listPath }, "Unable to prepare the AWS connection");
      if (typeof body.accountId !== "string" || typeof body.cloudFormationUrl !== "string") {
        throw new Error("One-click AWS setup is not available here yet.");
      }
      sessionStorage.setItem(storageKey, body.accountId);
      setSetupId(body.accountId);
      setLaunchUrl(body.cloudFormationUrl);
      setState({ status: "waiting" });
      if (tab) { tab.opener = null; tab.location.href = body.cloudFormationUrl; }
      else window.open(body.cloudFormationUrl, "_blank", "noopener");
    } catch (failure) {
      tab?.close();
      setError(errorMessage(failure, "Unable to prepare the AWS connection"));
    } finally {
      setLaunching(false);
    }
  }

  const connected = state.status === "connected";
  if (!setupId) {
    return <>
      <Intro provider="aws" title="Connect AWS CloudWatch">Launch one CloudFormation stack, once. It creates a read-only role and, where Superlog can receive CloudWatch logs, a role that only manages log subscriptions. Signal connects when it finishes.</Intro>
      {error && <p className="signalError" role="alert">{error}</p>}
      <section className="signalAccess">
        <h3>How it works</h3>
        <ol className="signalSteps">
          <li>Sign in to the AWS account you want to connect. The stack opens with everything filled in.</li>
          <li>Check the box to allow IAM resources, then click <strong>Create stack</strong>.</li>
          <li>Come back here. Signal connects on its own when the stack finishes.</li>
        </ol>
        <p>Want to review it first? <a href={awsEndpoint(connectUrl ?? "/api/integrations/aws/connect", "/cloudformation-template")} target="_blank" rel="noreferrer">Download the template</a></p>
      </section>
      <AccessList title="The stack creates IAM roles and nothing else"
        allowed={[
          "Read-only role: the AWS-managed AIOpsAssistantPolicy, to read CloudWatch logs, metrics, alarms, and resources",
          "Subscription role, where Superlog can receive logs: creates and removes account-level CloudWatch Logs subscriptions that send error lines to Superlog",
        ]}
        denied="Cannot change resources, data protection, or retention, and costs nothing beyond CloudWatch ingestion" />
      <Actions onBack={onBack}>
        <Button variant="primary" loading={launching} disabled={!connectUrl} onClick={() => void launch()}><External>Launch stack in AWS</External></Button>
      </Actions>
    </>;
  }

  return <>
    <Intro provider="aws" title="Connect AWS CloudWatch">{connected
      ? "Signal can now read CloudWatch logs, metrics, and alarms in this account."
      : "Finish creating the stack in AWS. This page updates on its own."}</Intro>
    {pollFailed && !connected && <p className="signalError" role="alert">Could not check the stack. Retrying…</p>}
    {connected
      ? <section className="signalCard">
        <header className="signalCard__header signalCard__header--success">
          <span className="signalStepMarker signalStepMarker--success"><IconCheck size={13} stroke={3} /></span>
          <div><h3>AWS account {state.awsAccountId} connected</h3><p>The stack finished and Signal assumed the role.</p></div>
        </header>
        <dl className="signalDetails">
          <div><dt>Account</dt><dd>{state.awsAccountId}</dd></div>
          <div><dt>Role</dt><dd><code>{state.roleArn}</code></dd></div>
        </dl>
      </section>
      : <ol className="signalCard signalStepCard">
        <li>
          <StepMarker state="done" number={1} />
          <div><h3>Stack opened in AWS</h3><p>ResponderInvestigationAccess</p></div>
          {launchUrl && <a className="dsButton dsButton--secondary dsButton--medium" href={launchUrl} target="_blank" rel="noreferrer"><External>Open again</External></a>}
        </li>
        <li>
          <StepMarker state={state.status === "waiting" ? "current" : "done"} number={2} />
          <div><h3>{state.status === "waiting" ? "Waiting for the stack" : "Stack created"}</h3>
            <p>{state.status === "waiting" ? <>Click <strong>Create stack</strong> in AWS. It usually finishes in about a minute.</> : `Account ${state.awsAccountId}`}</p></div>
        </li>
        <li className={state.status === "waiting" ? "isPending" : undefined}>
          <StepMarker state={state.status === "verifying" ? "current" : "pending"} number={3} />
          <div><h3>Verify the role</h3><p>Signal assumes the role once to check it works.</p></div>
        </li>
      </ol>}
    {connected && <AwsLogStreamingSettings integrationAccountId={state.integrationAccountId ?? setupId} />}
    <Actions onBack={() => {
      if (!connected) { sessionStorage.removeItem(storageKey); setSetupId(null); setPollFailed(false); return; }
      onBack();
    }}>
      <Button variant="primary" disabled={!connected} onClick={() => { sessionStorage.removeItem(storageKey); onDone(); }}>Continue</Button>
    </Actions>
  </>;
}

// --- Google Cloud -----------------------------------------------------------

interface GcpProject { name: string; projectId: string }

function gcpEndpoint(connectUrl: string, endpoint: string) {
  const parts = connectUrl.split("?")[0]!.split("/");
  parts.pop();
  return `${parts.join("/")}/${endpoint}`;
}

function GcpConnect({ integration, listPath, onBack, onDone }: PageProps) {
  const [selectionState] = useState(() => currentProjectSelectionState("gcp"));
  const [projects, setProjects] = useState<GcpProject[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [started, setStarted] = useState<{ accountId: string; setup: GcpSetupStatus } | null>(null);
  const setup = useGcpSetupStatus(started?.accountId ?? null, started?.setup ?? null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const connectUrl = integration?.connectUrl;
  // Google sends people back to the project picker, even for a project added
  // to a connected Google Cloud.
  const returnTo = `${listPath}/gcp/connect`;

  useEffect(() => {
    if (!selectionState || !connectUrl) return;
    let ignore = false;
    const url = new URL(gcpEndpoint(connectUrl, "projects"), window.location.origin);
    url.searchParams.set("state", selectionState);
    fetch(`${url.pathname}${url.search}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { error?: string; projects?: GcpProject[] } | null;
        if (!response.ok || !body?.projects) throw new Error(body?.error ?? "Unable to load Google Cloud projects");
        if (ignore) return;
        setProjects(body.projects);
        setProjectId(body.projects[0]?.projectId ?? "");
      })
      .catch((failure: unknown) => { if (!ignore) setError(errorMessage(failure, "Unable to load Google Cloud projects")); });
    return () => { ignore = true; };
  }, [connectUrl, selectionState]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!connectUrl || !projectId || submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const body = await postJson(gcpEndpoint(connectUrl, "select-project"), { projectId, selectionState }, "Unable to start Google Cloud setup");
      if (typeof body.accountId !== "string" || !body.setup) throw new Error("Unable to start Google Cloud setup");
      setStarted({ accountId: body.accountId, setup: body.setup as GcpSetupStatus });
    } catch (failure) {
      setError(errorMessage(failure, "Unable to start Google Cloud setup"));
    } finally {
      setSubmitting(false);
    }
  }

  if (started && setup) {
    const current = GCP_SETUP_STEPS.findIndex((step) => step.id === setup.step);
    const done = setup.status === "succeeded";
    return <>
      <Intro provider="gcp" title="Connect Google Cloud">{done
        ? `Signal can now read logs and metrics in ${projectId}.`
        : `Setting up ${projectId}. You can leave this page; setup continues and Settings shows its progress.`}</Intro>
      {setup.status === "failed" && <p className="signalError" role="alert">{setup.message ?? "Setup failed."}</p>}
      <ol className="signalCard signalStepCard">
        {GCP_SETUP_STEPS.map((step, index) => {
          const state = done || index < current ? "done" : index === current ? (setup.status === "failed" ? "failed" : "current") : "pending";
          return <li key={step.id} className={state === "pending" ? "isPending" : undefined}>
            <StepMarker state={state} number={index + 1} />
            <div><h3>{state === "current" ? step.progress : step.label}</h3></div>
          </li>;
        })}
      </ol>
      <Actions onBack={onBack}><Button variant="primary" disabled={!done} onClick={onDone}>Continue</Button></Actions>
    </>;
  }

  if (selectionState) {
    return <form className="signalConnectForm" onSubmit={(event) => void start(event)}>
      <Intro provider="gcp" title="Connect Google Cloud">Choose the project Signal should read.</Intro>
      <div className={`signalInput${error ? " signalInput--error" : ""}`}>
        <label htmlFor="signal-gcp-project">Google Cloud project</label>
        <select id="signal-gcp-project" disabled={!projects?.length} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {!projects && <option value="">Loading projects…</option>}
          {projects?.length === 0 && <option value="">No projects found</option>}
          {projects?.map((project) => <option key={project.projectId} value={project.projectId}>{project.projectId}{project.name && project.name !== project.projectId ? ` · ${project.name}` : ""}</option>)}
        </select>
        {error ? <p className="signalFieldError" role="alert"><IconAlertCircle size={14} />{error}</p>
          : <p>Signal creates a read-only service account in {projectId || "the project"} with Logs Viewer, Monitoring Viewer, and Cloud Asset Viewer roles. Your Google sign-in is revoked when setup finishes.</p>}
      </div>
      <Actions onBack={onBack}><Button type="submit" variant="primary" loading={submitting} disabled={!projectId}>Set up project</Button></Actions>
    </form>;
  }

  return <>
    <Intro provider="gcp" title="Connect Google Cloud">Sign in with a Google account that owns the project. Signal gets short-lived, read-only tokens; no service account keys are created or stored.</Intro>
    <AccessList title="In the project you choose, Signal will"
      allowed={["Create a read-only service account", "Grant it Logs Viewer, Monitoring Viewer, and Cloud Asset Viewer"]}
      denied="Keep your Google sign-in after setup finishes" />
    <Actions onBack={onBack}>
      <Button variant="primary" disabled={!connectUrl} onClick={() => window.location.assign(connectionStartUrl(connectUrl!, returnTo))}><External>Continue with Google</External></Button>
    </Actions>
  </>;
}
