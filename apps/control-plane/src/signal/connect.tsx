import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconAlertCircle,
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import type { SignalIntegrationSummary } from "../agents-api";
import { langfuseCloudDeployments } from "@responder/core/integrations/langfuse-deployments";
import { DATADOG_SITES, type DatadogSiteId } from "../components/datadog-sites";
import { AwsLogStreaming } from "../components/aws-log-streaming";
import { ScrollArea } from "../components/ui/scroll-area";
import { Button } from "../design-system";
import { gcpSetupProgressLabel, useGcpSetupStatuses, type GcpAccountSetup } from "../gcp-setup-status";
import { createIngestKey, existingOpenTelemetryPrompt, openTelemetryPrompt } from "../ingest-keys-api";
import { currentProjectSelectionState } from "../project-selection";
import { fetchServices } from "../telemetry-api";
import type { ConnectPage } from "./connect-pages";
import { connectionStartUrl } from "./model";
import { SignalLogo } from "./shared";


interface PageProps {
  integration: SignalIntegrationSummary | undefined;
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
    case "jira": return <JiraConnect {...props} />;
    case "langfuse": return <LangfuseConnect {...props} />;
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

// --- Jira ------------------------------------------------------------------

// What Signal does with Jira, shared by its connect and manage pages.
export const jiraSignalUse = "Signal files findings as Jira issues, from a button or for every finding, and skips problems already filed.";

// The page to return to after connecting: the notifications settings when
// they sent the member here to set up filing.
function jiraReturnTo(listPath: string) {
  return new URLSearchParams(window.location.search).get("next") === "notifications" ? "/signal/setup/notifications" : listPath;
}

function JiraConnect({ integration, listPath, onBack }: PageProps) {
  const navigate = useNavigate();
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!integration?.connectUrl || submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const body = await postJson(integration.connectUrl, { siteUrl, email, token, returnTo: jiraReturnTo(listPath) }, "Unable to connect Jira");
      if (typeof body.redirectUrl !== "string") throw new Error("Unable to connect Jira");
      window.location.assign(body.redirectUrl);
    } catch (failure) {
      setError(errorMessage(failure, "Unable to connect Jira"));
      setSubmitting(false);
    }
  }
  // Back returns where the member came from, like a successful connection.
  const back = jiraReturnTo(listPath) === listPath ? onBack : () => navigate(jiraReturnTo(listPath));

  return <form className="signalConnectForm" onSubmit={(event) => void connect(event)}>
    <Intro provider="jira" title="Connect Jira">{jiraSignalUse}</Intro>
    <div className="signalInput">
      <label htmlFor="signal-jira-site">Jira site</label>
      <input id="signal-jira-site" autoComplete="off" spellCheck={false} placeholder="your-team.atlassian.net" required value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
      <p>Jira Cloud only. Issues are created as the account that owns the API token.</p>
    </div>
    <div className="signalInput">
      <label htmlFor="signal-jira-email">Atlassian account email</label>
      <input id="signal-jira-email" type="email" autoComplete="off" spellCheck={false} placeholder="you@company.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
    </div>
    <div className={`signalInput${error ? " signalInput--error" : ""}`}>
      <label htmlFor="signal-jira-token">API token</label>
      <ol className="signalInstructions">
        <li><span>Open <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">API tokens</a> in your Atlassian account and create a token. A service account that can create issues in the project works best.</span></li>
        <li>Paste the token below.</li>
      </ol>
      <input id="signal-jira-token" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your Atlassian API token" required value={token} onChange={(e) => setToken(e.target.value)} />
      {error ? <p className="signalFieldError" role="alert"><IconAlertCircle size={14} />{error}</p>
        : <p>Stored encrypted. Signal uses it only to file findings and search issues.</p>}
    </div>
    <Actions onBack={back}>
      <Button type="submit" variant="primary" loading={submitting} disabled={!integration?.connectUrl || !siteUrl.trim() || !email.trim() || !token.trim()}>Connect Jira</Button>
    </Actions>
  </form>;
}

// --- Langfuse --------------------------------------------------------------

// What Signal does with Langfuse, shared by its connect and manage pages.
export const langfuseSignalReads = "Signal reads your LLM traces, observations, scores, and metrics. It never changes anything in Langfuse.";

const langfuseDeployments = [...langfuseCloudDeployments, { id: "self_hosted", name: "Self-hosted", baseUrl: "" }] as const;
type LangfuseDeploymentId = (typeof langfuseDeployments)[number]["id"];

function LangfuseConnect({ integration, listPath, onBack }: PageProps) {
  const [deployment, setDeployment] = useState<LangfuseDeploymentId>("cloud_eu");
  const [selfHostedUrl, setSelfHostedUrl] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const selected = langfuseDeployments.find((candidate) => candidate.id === deployment)!;
  const selfHosted = deployment === "self_hosted";
  const baseUrl = selfHosted ? selfHostedUrl.trim() : selected.baseUrl;

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!integration?.connectUrl || submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const body = await postJson(integration.connectUrl, { baseUrl, publicKey, returnTo: listPath, secretKey }, "Unable to connect Langfuse");
      if (typeof body.redirectUrl !== "string") throw new Error("Unable to connect Langfuse");
      window.location.assign(body.redirectUrl);
    } catch (failure) {
      setError(errorMessage(failure, "Unable to connect Langfuse"));
      setSubmitting(false);
    }
  }

  return <form className="signalConnectForm" onSubmit={(event) => void connect(event)}>
    <Intro provider="langfuse" title="Connect Langfuse">{langfuseSignalReads}</Intro>
    <div className="signalInput">
      <label htmlFor="signal-langfuse-deployment">Deployment</label>
      <select id="signal-langfuse-deployment" value={deployment} onChange={(e) => { setDeployment(e.target.value as LangfuseDeploymentId); setError(""); }}>
        {langfuseDeployments.map((candidate) => <option key={candidate.id} value={candidate.id}>
          {candidate.baseUrl ? `${candidate.name} · ${candidate.baseUrl.replace("https://", "")}` : candidate.name}
        </option>)}
      </select>
      <ol className="signalInstructions">
        <li>In Langfuse, open the project Signal should read, then <strong>Settings → API Keys</strong>.</li>
        <li>Create a key pair for Signal and paste both keys below. Langfuse shows the secret key only once.</li>
      </ol>
    </div>
    {selfHosted && <div className="signalInput">
      <label htmlFor="signal-langfuse-url">Langfuse URL</label>
      <input id="signal-langfuse-url" type="url" spellCheck={false} placeholder="https://langfuse.example.com" required value={selfHostedUrl} onChange={(e) => setSelfHostedUrl(e.target.value)} />
    </div>}
    <div className="signalInput">
      <label htmlFor="signal-langfuse-public-key">Public key</label>
      <input id="signal-langfuse-public-key" autoComplete="off" spellCheck={false} placeholder="pk-lf-…" required value={publicKey} onChange={(e) => setPublicKey(e.target.value)} />
    </div>
    <div className={`signalInput${error ? " signalInput--error" : ""}`}>
      <label htmlFor="signal-langfuse-secret-key">Secret key</label>
      <input id="signal-langfuse-secret-key" type="password" autoComplete="off" spellCheck={false} placeholder="sk-lf-…" required value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
      {error ? <p className="signalFieldError" role="alert"><IconAlertCircle size={14} />{error}</p>
        : <p>Stored encrypted. Signal uses the keys only to read.</p>}
    </div>
    <Actions onBack={onBack}>
      <Button type="submit" variant="primary" loading={submitting} disabled={!integration?.connectUrl || !baseUrl || !publicKey.trim() || !secretKey.trim()}>Connect Langfuse</Button>
    </Actions>
  </form>;
}

// --- Providers approved on their own site -----------------------------------

// What Signal does with Railway, shared by its connect and manage pages.
export const railwaySignalReads = "Signal reads your Railway logs, deployments, and metrics.";
// What Signal does with Vercel, shared by its connect and manage pages.
export const vercelSignalReads = "Signal reads your Vercel projects, deployments, and logs.";
// What Signal does with PostHog, shared by its connect and manage pages.
export const postHogSignalReads = "Signal reads your PostHog logs and errors, and uses product usage to tell how many customers a problem affects.";
// What Signal does with Axiom, shared by its connect and manage pages.
export const axiomSignalReads = "Signal queries your datasets, metrics, and monitors. It never changes anything in Axiom.";

const approvals: Record<"axiom" | "sentry" | "linear" | "posthog" | "railway" | "vercel", {
  name: string; description: string; allowed: string[]; denied: string;
  // Come back to this page rather than the list, to finish setup here.
  returnHere?: boolean;
  // Sent as the start URL's `mode`.
  mode?: string;
}> = {
  axiom: {
    name: "Axiom",
    description: axiomSignalReads,
    allowed: ["Query logs and traces in your datasets", "Read metrics, monitors, monitor history, and dashboards"],
    denied: "Never changes datasets, monitors, dashboards, or notifiers",
  },
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
    description: `${postHogSignalReads} After you connect, choose the projects whose error logs Superlog reads, so Signal sees new errors as they happen.`,
    allowed: ["Read logs, errors, and session replays", "Read insights, dashboards, and events"],
    denied: "Read-only access. Nothing in PostHog can be changed",
    returnHere: true,
    mode: "signal",
  },
  railway: {
    name: "Railway",
    description: `${railwaySignalReads} After you connect, choose the environments whose logs Superlog reads, so Signal sees new errors as they happen.`,
    allowed: ["Read projects, deployments, and runtime, build, and HTTP logs", "Read resource and HTTP metrics"],
    denied: "Read-only access. Never redeploys, restarts, or reads environment variables",
    returnHere: true,
  },
  vercel: {
    name: "Vercel",
    description: `${vercelSignalReads} When you connect, Superlog creates drains that send your deployments' traces and logs to it, so Signal sees new errors as they happen.`,
    allowed: ["Read projects, deployments, domains, and logs", "Create drains that send traces and logs to Superlog"],
    denied: "Never changes deployments or reads environment variables",
    returnHere: true,
    mode: "drains",
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
      {/* Railway starts read-only when no access mode is given. */}
      <Button variant="primary" loading={leaving} disabled={!integration?.connectUrl} onClick={() => {
        setLeaving(true);
        const start = new URL(integration!.connectUrl!, window.location.origin);
        if (approval.mode) start.searchParams.set("mode", approval.mode);
        window.location.assign(connectionStartUrl(`${start.pathname}${start.search}`, approval.returnHere ? `${listPath}/${page}` : listPath));
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
      ? <AwsLogStreaming integrationAccountId={state.integrationAccountId ?? setupId ?? ""}>
        {({ notice, row }) => <>
          <section className="signalCard">
            <header className="signalCard__header signalCard__header--success">
              <span className="signalStepMarker signalStepMarker--success"><IconCheck size={13} stroke={3} /></span>
              <div><h3>AWS account {state.awsAccountId} connected</h3><p>The stack finished and Signal assumed the role.</p></div>
            </header>
            <dl className="signalDetails">
              <div><dt>Account</dt><dd>{state.awsAccountId}</dd></div>
              <div><dt>Role</dt><dd><code>{state.roleArn}</code></dd></div>
              {row && <div className="signalDetails__regions"><dt>Telemetry from</dt><dd>{row}</dd></div>}
            </dl>
          </section>
          {notice}
        </>}
      </AwsLogStreaming>
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
  const [selected, setSelected] = useState<string[]>([]);
  const [started, setStarted] = useState<GcpAccountSetup[] | null>(null);
  const accounts = useGcpSetupStatuses(started);
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
        if (body.projects.length === 1) setSelected([body.projects[0]!.projectId]);
      })
      .catch((failure: unknown) => { if (!ignore) setError(errorMessage(failure, "Unable to load Google Cloud projects")); });
    return () => { ignore = true; };
  }, [connectUrl, selectionState]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!connectUrl || selected.length === 0 || submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const body = await postJson(gcpEndpoint(connectUrl, "select-project"), { projectIds: selected, selectionState }, "Unable to start Google Cloud setup");
      if (!Array.isArray(body.accounts) || body.accounts.length === 0) throw new Error("Unable to start Google Cloud setup");
      setStarted(body.accounts as GcpAccountSetup[]);
    } catch (failure) {
      setError(errorMessage(failure, "Unable to start Google Cloud setup"));
    } finally {
      setSubmitting(false);
    }
  }

  if (accounts) {
    const running = accounts.some((account) => account.setup.status === "running");
    const succeeded = accounts.filter((account) => account.setup.status === "succeeded");
    const done = !running && succeeded.length > 0;
    return <>
      <Intro provider="gcp" title="Connect Google Cloud">{running
        ? "Setting up your projects. You can leave this page; setup continues and Settings shows its progress."
        : succeeded.length === accounts.length
          ? "Signal can now read logs and metrics in these projects."
          : "Some projects could not be set up. Signal reads the ones that connected."}</Intro>
      <ol className="signalCard signalStepCard">
        {accounts.map((account, index) => {
          const state = account.setup.status === "succeeded" ? "done" : account.setup.status === "failed" ? "failed" : "current";
          return <li key={account.accountId}>
            <StepMarker state={state} number={index + 1} />
            <div>
              <h3>{account.projectId}</h3>
              <p role={state === "failed" ? "alert" : undefined}>{gcpSetupProgressLabel(account.setup)}</p>
            </div>
          </li>;
        })}
      </ol>
      <Actions onBack={onBack}><Button variant="primary" disabled={!done} onClick={onDone}>Continue</Button></Actions>
    </>;
  }

  if (selectionState) {
    return <form className="signalConnectForm" onSubmit={(event) => void start(event)}>
      <Intro provider="gcp" title="Connect Google Cloud">Choose the projects Signal should read.</Intro>
      <GcpProjectPicker projects={projects} selected={selected} onChange={setSelected} />
      {error ? <p className="signalFieldError" role="alert"><IconAlertCircle size={14} />{error}</p>
        : <p className="signalGcpNote">Signal creates a read-only service account in each project with Logs Viewer, Monitoring Viewer, and Cloud Asset Viewer roles. Your Google sign-in is revoked when setup finishes.</p>}
      <Actions onBack={onBack}>
        <Button type="submit" variant="primary" loading={submitting} disabled={selected.length === 0}>
          {selected.length > 1 ? `Set up ${selected.length} projects` : "Set up project"}
        </Button>
      </Actions>
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

function GcpProjectPicker({ projects, selected, onChange }: {
  projects: GcpProject[] | null;
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  // True while rows are hidden below the visible part of the list.
  const [more, setMore] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const query = search.trim().toLowerCase();
  const matches = (projects ?? []).filter((project) =>
    project.projectId.toLowerCase().includes(query) || project.name.toLowerCase().includes(query));
  const updateMore = useCallback(() => {
    const viewport = pickerRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    setMore(Boolean(viewport && viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1));
  }, []);
  useEffect(updateMore, [updateMore, matches.length]);
  return <div className="signalRepositories" ref={pickerRef}>
    <div className="signalRepoSearch">
      <label className="signalSearch"><IconSearch size={14} /><input aria-label="Search projects" placeholder="Search projects…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      {projects && <span>{selected.length} of {projects.length} selected</span>}
    </div>
    <ScrollArea type="auto" className={`signalRepoList${more ? " signalRepoList--more" : ""}`} aria-label="Google Cloud projects" onScrollCapture={updateMore}>
      {matches.map((project) => <label className="signalRepoRow" key={project.projectId}>
        <span className="signalRepoCheckbox">
          <input type="checkbox" checked={selected.includes(project.projectId)} onChange={(e) => onChange(e.target.checked
            ? [...selected, project.projectId]
            : selected.filter((id) => id !== project.projectId))} />
          <IconCheck aria-hidden="true" size={12} />
        </span>
        <span>{project.projectId}</span>
        {project.name && project.name !== project.projectId && <span className="signalGcpProjectName">{project.name}</span>}
      </label>)}
      {!projects && <p className="signalEmpty">Loading projects…</p>}
      {projects?.length === 0 && <p className="signalEmpty">No projects found.</p>}
      {projects && projects.length > 0 && matches.length === 0 && <p className="signalEmpty">No projects match “{search}”.</p>}
    </ScrollArea>
  </div>;
}
