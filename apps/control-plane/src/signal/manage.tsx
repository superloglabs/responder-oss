import { useEffect, useState, type ReactNode } from "react";
import { IconCheck, IconExclamationMark } from "@tabler/icons-react";
import { removeIntegrationAccount, type IntegrationAccount, type IntegrationSummary } from "../agents-api";
import { AwsLogStreaming } from "../components/aws-log-streaming";
import { Button } from "../design-system";
import { CloudSourceSetup } from "../pages/telemetry-source";
import { fetchServices } from "../telemetry-api";
import { Actions, Intro } from "./connect";
import type { ConnectPage } from "./connect-pages";
import { manageableAccounts, manageView, type ManageRow } from "./manage-model";
import { foundLabel } from "./model";

interface ManageProps {
  page: ConnectPage;
  // The name the setup list uses, e.g. "AWS CloudWatch".
  name: string;
  integration: IntegrationSummary | undefined;
  onBack: () => void;
  // Opens the connect form again, to replace keys or sign in again.
  onReconnect: () => void;
  onRemoved: () => void;
  onOpenIngestKeys: () => void;
}

const descriptions: Record<ConnectPage, string> = {
  otel: "Your services send logs, traces, and metrics to Superlog. Signal reads them from there.",
  datadog: "Signal reads your monitors, logs, traces, and metrics. It never changes anything in Datadog.",
  grafana: "Signal reads your dashboards, alerts, and datasources. It never changes anything in Grafana.",
  sentry: "Signal reads your errors and issues to find what broke and who it affects.",
  aws: "Signal reads CloudWatch logs, metrics, and alarms through a read-only role.",
  gcp: "Signal reads logs and metrics in your project through a read-only service account.",
  linear: "Signal checks Linear before posting, so it skips problems your team already tracks.",
  posthog: "Signal uses product usage to tell how many customers a problem affects.",
};

export function SignalManage(props: ManageProps) {
  const { page, name, integration, onBack } = props;
  const accounts = manageableAccounts(integration?.accounts);
  return <>
    <Intro provider={page} title={name}>{descriptions[page]}</Intro>
    {page === "otel"
      ? <OpenTelemetryStatus onShowPrompt={props.onReconnect} onOpenIngestKeys={props.onOpenIngestKeys} />
      : accounts.map((account) => <ManagedAccount key={account.id}
        provider={page}
        name={name}
        account={account}
        // With several accounts, each Disconnect names its own.
        several={accounts.length > 1}
        // Each AWS account chooses its regions in its details; without log
        // streaming here, the CloudWatch stream setup is shown once.
        awsStreaming={page === "aws" ? { fallback: account === accounts.at(-1) ? <CloudStream provider="aws" /> : null } : undefined}
        // Sending telemetry covers the workspace, so it is shown once.
        stream={page === "gcp" && account === accounts.at(-1) ? <CloudStream provider={page} /> : null}
        onReconnect={props.onReconnect}
        onRemoved={props.onRemoved} />)}
    <Actions onBack={onBack}><Button variant="primary" onClick={onBack}>Done</Button></Actions>
  </>;
}

function Status({ failed = false, title, children, action }: { failed?: boolean; title: string; children: string; action?: ReactNode }) {
  return <div className={`signalStatus${failed ? " signalStatus--failed" : ""}`} role={failed ? "alert" : undefined}>
    <span className="signalStatus__icon" aria-hidden="true">{failed ? <IconExclamationMark size={13} stroke={3} /> : <IconCheck size={13} stroke={3} />}</span>
    <div><h3>{title}</h3><p>{children}</p></div>
    {action}
  </div>;
}

function Rows({ rows, extra }: { rows: Array<ManageRow & { onAction?: () => void }>; extra?: ReactNode }) {
  if (rows.length === 0 && !extra) return null;
  return <div className="signalCard signalManageRows">
    {rows.map((row) => <div key={row.label}>
      <span className="signalManageRows__label">{row.label}</span>
      <span className="signalManageRows__value">
        {row.code ? <code>{row.value}</code> : row.value}
        {row.note && <span> · {row.note}</span>}
      </span>
      {row.action && row.onAction && <Button onClick={row.onAction}>{row.action}</Button>}
    </div>)}
    {extra}
  </div>;
}

function updatedLabel(updatedAt: string) {
  const label = foundLabel(new Date(updatedAt), new Date());
  return `Last updated ${label === "Just now" || label === "Yesterday" ? label.toLowerCase() : label}.`;
}

function ManagedAccount({ provider, name, account, several, awsStreaming, stream, onReconnect, onRemoved }: {
  provider: ConnectPage; name: string; account: IntegrationAccount; several: boolean;
  awsStreaming?: { fallback: ReactNode }; stream: ReactNode;
  onReconnect: () => void; onRemoved: () => void;
}) {
  const view = manageView(provider, name, account);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const failed = account.status === "error";
  const subject = several ? view.connectedTo.replace(/^the /u, "") : name;

  async function remove() {
    setRemoving(true);
    setError("");
    try {
      await removeIntegrationAccount(provider, account.id);
      onRemoved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not disconnect.");
      setRemoving(false);
    }
  }

  return <>
    {failed
      ? <Status failed title={`Signal lost access to ${name}`}
        action={<Button variant="primary" onClick={onReconnect}>Reconnect</Button>}>
        {`Signal can't read ${view.connectedTo.replace(/^the /u, "")} until you reconnect.`}
      </Status>
      : <Status title={`Connected to ${view.connectedTo}`}>{updatedLabel(account.updatedAt)}</Status>}
    {awsStreaming
      ? <AwsLogStreaming integrationAccountId={account.id} fallback={awsStreaming.fallback}>
        {({ notice, row }) => <>
          <Rows rows={view.rows.map((row) => ({ ...row, onAction: onReconnect }))}
            extra={row && <div className="signalManageRows__regions">
              <span className="signalManageRows__label">Telemetry from</span>
              {row}
            </div>} />
          {notice}
        </>}
      </AwsLogStreaming>
      : <Rows rows={view.rows.map((row) => ({ ...row, onAction: onReconnect }))} />}
    {stream}
    <div className={`signalDisconnect${confirming ? " signalDisconnect--confirm" : ""}`}>
      <div>
        <h3>{confirming ? `Disconnect ${subject}?` : `Disconnect ${subject}`}</h3>
        <p>{view.disconnect}</p>
        {error && <p className="signalError" role="alert">{error}</p>}
      </div>
      {confirming
        ? <div className="signalDisconnect__actions">
          <Button disabled={removing} onClick={() => { setConfirming(false); setError(""); }}>Cancel</Button>
          <Button variant="danger" loading={removing} onClick={() => void remove()}>Disconnect {subject}</Button>
        </div>
        : <Button className="signalDisconnect__start" onClick={() => setConfirming(true)}>Disconnect</Button>}
    </div>
  </>;
}

const streamText: Record<"aws" | "gcp", { title: string; body: string }> = {
  aws: {
    title: "Send CloudWatch to Signal",
    body: "With CloudWatch logs and metrics sent to Superlog, Signal sees each new error as it arrives. Without them, Signal only reads CloudWatch while it investigates.",
  },
  gcp: {
    title: "Send Google Cloud to Signal",
    body: "With the project's logs and metrics read into Superlog, Signal sees each new error as it arrives. Without them, Signal only reads the project while it investigates.",
  },
};

// The connection above lets Signal read the provider while it investigates.
// Sending its telemetry to Superlog is what lets Signal find new problems.
function CloudStream({ provider }: { provider: "aws" | "gcp" }) {
  return <section className="signalCloudStream" aria-labelledby={`signal-${provider}-stream`}>
    <h3 id={`signal-${provider}-stream`}>{streamText[provider].title}</h3>
    <p>{streamText[provider].body}</p>
    <div className="telemetrySetup"><CloudSourceSetup provider={provider} /></div>
  </section>;
}

// OpenTelemetry has no account: services send data with an ingest key.
function OpenTelemetryStatus({ onShowPrompt, onOpenIngestKeys }: { onShowPrompt: () => void; onOpenIngestKeys: () => void }) {
  const [services, setServices] = useState<string[] | null>(null);
  // Bumped by "Try again"; a failed load is not the same as no data.
  const [attempt, setAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const endpoint = `${window.location.origin}/api/ingest`;

  useEffect(() => {
    let current = true;
    const until = Date.now();
    fetchServices({ since: until - 86_400_000, until }, "all")
      .then((names) => { if (current) setServices([...names].sort()); })
      .catch(() => { if (current) setLoadFailed(true); });
    return () => { current = false; };
  }, [attempt]);

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // The endpoint stays on screen to copy by hand.
    }
  }

  if (loadFailed) {
    return <Status failed title="Could not check for data"
      action={<Button onClick={() => { setLoadFailed(false); setAttempt(attempt + 1); }}>Try again</Button>}>
      Signal could not load the services sending data.
    </Status>;
  }
  if (!services) return <p className="signalLoading" role="status">Loading…</p>;
  const count = `${services.length} ${services.length === 1 ? "service" : "services"}`;
  return <>
    {services.length > 0
      ? <Status title={`Receiving data from ${count}`}>Services that sent data in the last 24 hours.</Status>
      : <Status failed title="No data in the last 24 hours"
        action={<Button variant="primary" onClick={onShowPrompt}>Show setup prompt</Button>}>
        Check that your services still export to Superlog.
      </Status>}
    <Rows rows={[
      ...(services.length > 0 ? [{ label: "Services", value: services.join(", "), code: true }] : []),
      { label: "Endpoint", value: endpoint, code: true, action: copied ? "Copied" : "Copy", onAction: () => void copyEndpoint() },
      { label: "Agent prompt", value: "Paste into your coding agent to add another service.", action: "Show prompt", onAction: onShowPrompt },
      { label: "Ingest keys", value: "Services send data with an ingest key. Revoke one to stop it.", action: "Manage keys", onAction: onOpenIngestKeys },
    ]} />
  </>;
}
