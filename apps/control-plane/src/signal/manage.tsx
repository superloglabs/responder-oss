import { useEffect, useState, type ReactNode } from "react";
import { IconCheck, IconExclamationMark } from "@tabler/icons-react";
import { removeIntegrationAccount, type IntegrationAccount, type IntegrationSummary } from "../agents-api";
import { Button } from "../design-system";
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

function Rows({ rows }: { rows: Array<ManageRow & { onAction?: () => void }> }) {
  if (rows.length === 0) return null;
  return <div className="signalCard signalManageRows">
    {rows.map((row) => <div key={row.label}>
      <span className="signalManageRows__label">{row.label}</span>
      <span className="signalManageRows__value">
        {row.code ? <code>{row.value}</code> : row.value}
        {row.note && <span> · {row.note}</span>}
      </span>
      {row.action && row.onAction && <Button onClick={row.onAction}>{row.action}</Button>}
    </div>)}
  </div>;
}

function updatedLabel(updatedAt: string) {
  const label = foundLabel(new Date(updatedAt), new Date());
  return `Last updated ${label === "Just now" || label === "Yesterday" ? label.toLowerCase() : label}.`;
}

function ManagedAccount({ provider, name, account, several, onReconnect, onRemoved }: {
  provider: ConnectPage; name: string; account: IntegrationAccount; several: boolean;
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
    <Rows rows={view.rows.map((row) => ({ ...row, onAction: onReconnect }))} />
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

// OpenTelemetry has no account: services send data with an ingest key.
function OpenTelemetryStatus({ onShowPrompt, onOpenIngestKeys }: { onShowPrompt: () => void; onOpenIngestKeys: () => void }) {
  const [services, setServices] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const endpoint = `${window.location.origin}/api/ingest`;

  useEffect(() => {
    let current = true;
    const until = Date.now();
    fetchServices({ since: until - 86_400_000, until }, "all")
      .then((names) => { if (current) setServices([...names].sort()); })
      .catch(() => { if (current) setServices([]); });
    return () => { current = false; };
  }, []);

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // The endpoint stays on screen to copy by hand.
    }
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
