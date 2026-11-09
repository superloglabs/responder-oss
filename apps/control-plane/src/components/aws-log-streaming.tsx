import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconExternalLink, IconPlus, IconX } from "@tabler/icons-react";
import {
  awsLogSubscriptionStatusLabels,
  fetchAwsLogStreaming,
  saveAwsLogStreaming,
  type AwsLogStreaming as AwsLogStreamingState,
} from "../aws-log-subscriptions-api";
import { Alert, Button, CodeBlock } from "../design-system";
import "./aws-log-streaming.css";

// The parts of a connected AWS account's log streaming (ADR 0015): `row` is
// the value of the account's "Telemetry from" row, the regions whose error
// lines reach Superlog; `notice` goes under the account's details, and asks
// for a stack update when the stack predates log streaming. Where this
// installation has no log streaming, `available` is false and `notice` is
// the fallback.
export interface AwsLogStreamingParts {
  available: boolean;
  notice: ReactNode;
  row: ReactNode;
}

export function AwsLogStreaming({ integrationAccountId, fallback = null, children }: {
  children: (parts: AwsLogStreamingParts) => ReactNode;
  fallback?: ReactNode;
  integrationAccountId: string;
}) {
  const [streaming, setStreaming] = useState<AwsLogStreamingState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    fetchAwsLogStreaming(integrationAccountId)
      .then((value) => { if (current) setStreaming(value); })
      .catch((failure: unknown) => { if (current) setLoadError(failure instanceof Error ? failure.message : "Could not load log streaming."); });
    return () => { current = false; };
  }, [integrationAccountId]);

  // Refreshes while a region is starting, stopping, or waiting for the stack
  // update. The refresh also renews the update link, which lasts 15 minutes.
  // A failed refresh keeps the state but replaces the object, so the next one
  // is scheduled.
  const busy = streaming?.subscriptions.some((row) => row.status === "pending" || row.status === "removing") ?? false;
  const waiting = streaming?.subscriptions.some((row) => row.status === "waiting") ?? false;
  useEffect(() => {
    if (!busy && !waiting) return;
    const timer = window.setTimeout(() => {
      void fetchAwsLogStreaming(integrationAccountId)
        .then(setStreaming)
        .catch(() => setStreaming((current) => (current ? { ...current } : current)));
    }, busy ? 5_000 : 10_000);
    return () => window.clearTimeout(timer);
  }, [integrationAccountId, busy, waiting, streaming]);

  if (loadError) {
    return <>{children({ available: true, notice: <Alert tone="danger" title="Could not load log streaming">{loadError}</Alert>, row: null })}</>;
  }
  if (!streaming) return <>{children({ available: false, notice: null, row: null })}</>;
  if (!streaming.available) return <>{children({ available: false, notice: fallback, row: null })}</>;

  const regions = streaming.subscriptions.filter((row) => row.status !== "removing").map((row) => row.region);

  async function save(next: string[]) {
    setSaving(true);
    setError("");
    try {
      setStreaming(await saveAwsLogStreaming(integrationAccountId, next));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save log streaming.");
    } finally {
      setSaving(false);
    }
  }

  return <>{children({
    available: true,
    notice: streaming.stackUpdate ? <StackUpdate update={streaming.stackUpdate} /> : null,
    row: <RegionChips
      canManage={streaming.canManage}
      error={error}
      offered={streaming.regions}
      onAdd={(region) => void save([...regions, region])}
      onRemove={(region) => void save(regions.filter((value) => value !== region))}
      saving={saving}
      subscriptions={streaming.subscriptions} />,
  })}</>;
}

// For places without a details table, such as the Settings AWS card.
export function AwsLogStreamingSettings({ integrationAccountId, fallback = null }: {
  fallback?: ReactNode;
  integrationAccountId: string;
}) {
  return <AwsLogStreaming integrationAccountId={integrationAccountId} fallback={fallback}>
    {({ available, notice, row }) => <>
      {available && row && <div className="awsLogStreaming__row">
        <span className="awsLogStreaming__label">Telemetry from</span>
        {row}
      </div>}
      {notice}
    </>}
  </AwsLogStreaming>;
}

function RegionChips({ canManage, error, offered, onAdd, onRemove, saving, subscriptions }: {
  canManage: boolean;
  error: string;
  offered: string[];
  onAdd: (region: string) => void;
  onRemove: (region: string) => void;
  saving: boolean;
  subscriptions: AwsLogStreamingState["subscriptions"];
}) {
  const listed = new Set(subscriptions.map((row) => row.region));
  const addable = offered.filter((region) => !listed.has(region));
  const failures = subscriptions.filter((row) => row.lastError && (row.status === "failed" || row.status === "removing"));
  return <div className="awsLogStreaming__regions">
    <ul aria-label="Regions sending error lines to Superlog">
      {subscriptions.map((row) => {
        const status = awsLogSubscriptionStatusLabels[row.status];
        return <li key={row.region} className="awsRegionChip" title={row.lastError ?? undefined}>
          <code>{row.region}</code>
          <span className={`awsRegionChip__status awsRegionChip__status--${status.tone}`}>{status.label}</span>
          {canManage && row.status !== "removing" && <button
            aria-label={`Stop sending errors from ${row.region}`}
            className="awsRegionChip__remove"
            disabled={saving}
            onClick={() => onRemove(row.region)}
            type="button">
            <IconX aria-hidden="true" size={12} stroke={2} />
          </button>}
        </li>;
      })}
      {subscriptions.length === 0 && !canManage && <li className="awsLogStreaming__item awsLogStreaming__none">None</li>}
      {canManage && addable.length > 0 && <li className="awsLogStreaming__item"><AddRegion disabled={saving} regions={addable} onAdd={onAdd} /></li>}
    </ul>
    {failures.map((row) => <p key={row.region} className="awsLogStreaming__error">{row.region}: {row.lastError}</p>)}
    {error && <p className="awsLogStreaming__error" role="alert">{error}</p>}
  </div>;
}

function AddRegion({ disabled, regions, onAdd }: { disabled: boolean; regions: string[]; onAdd: (region: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Choosing a region closes the menu; focus goes back to the button so
  // keyboard users keep their place.
  const choose = (region: string) => {
    setOpen(false);
    onAdd(region);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <div className="awsAddRegion" ref={root}>
    <button aria-expanded={open} aria-haspopup="listbox" className="awsAddRegion__button" disabled={disabled} onClick={() => setOpen(!open)} ref={trigger} type="button">
      <IconPlus aria-hidden="true" size={13} stroke={2} />Add region
    </button>
    {open && <ul aria-label="Regions" className="awsAddRegion__menu" role="listbox">
      {regions.map((region) => <li key={region} aria-selected={false} role="option" tabIndex={0}
        onClick={() => choose(region)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(region); } }}>
        {region}
      </li>)}
    </ul>}
  </div>;
}

function StackUpdate({ update }: { update: NonNullable<AwsLogStreamingState["stackUpdate"]> }) {
  const [showCommand, setShowCommand] = useState(false);
  // Settings can show one of these per AWS account.
  const titleId = useId();
  return <section className="awsStackUpdate" aria-labelledby={titleId}>
    <div className="awsStackUpdate__text">
      <h3 id={titleId}>A new version of the Superlog AWS stack is available</h3>
      <p>It lets Superlog send new errors from the regions you choose. Updating takes about a minute in AWS and changes nothing else in your account.</p>
      <button className="awsStackUpdate__cli" onClick={() => setShowCommand(!showCommand)} type="button" aria-expanded={showCommand}>
        {showCommand ? "Hide the CLI command" : "Use the CLI instead"}
      </button>
      {showCommand && <CodeBlock code={update.command} language="bash" />}
    </div>
    {update.consoleUrl
      ? <a className="dsButton dsButton--primary dsButton--medium awsStackUpdate__action" href={update.consoleUrl} rel="noreferrer" target="_blank">
        Update in AWS<IconExternalLink aria-hidden="true" size={13} stroke={2} />
      </a>
      : <Button disabled variant="primary">Update in AWS</Button>}
  </section>;
}
