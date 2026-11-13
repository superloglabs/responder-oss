import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import {
  fetchRailwayLogReading,
  readRailwayEnvironment,
  removeTelemetrySource,
  sourceHealth,
  type RailwayEnvironmentOption,
  type RailwayLogReading as RailwayLogReadingState,
  type TelemetrySourceSummary,
} from "../telemetry-sources-api";
// The environment chips reuse the AWS region chips.
import "./aws-log-streaming.css";

// The Railway environments whose logs Superlog reads for one connection: the
// value of the connection's "Telemetry from" row. Errors in those logs become
// error issues, which alert people and start Signal. Where this workspace or
// cell cannot receive telemetry, `available` is false.
export interface RailwayLogReadingParts {
  available: boolean;
  row: ReactNode;
}

function environmentLabel(environment: Pick<RailwayEnvironmentOption, "environmentName" | "projectName">): string {
  return `${environment.projectName} · ${environment.environmentName}`;
}

export function RailwayLogReading({ integrationAccountId, children }: {
  children: (parts: RailwayLogReadingParts) => ReactNode;
  integrationAccountId: string;
}) {
  // Undefined while loading; null when telemetry is not available here.
  const [reading, setReading] = useState<RailwayLogReadingState | null | undefined>(undefined);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const next = await fetchRailwayLogReading(integrationAccountId);
    setReading(next);
    setLoadError("");
  }, [integrationAccountId]);

  useEffect(() => {
    let current = true;
    fetchRailwayLogReading(integrationAccountId)
      .then((value) => { if (current) setReading(value); })
      .catch((failure: unknown) => { if (current) setLoadError(failure instanceof Error ? failure.message : "Could not load Railway environments."); });
    return () => { current = false; };
  }, [integrationAccountId]);

  // A new environment shows "Waiting for data" until the worker's first read,
  // within a minute; the row refreshes until then.
  const waiting = reading?.sources.some((source) => !source.lastReceivedAt && source.status === "pending") ?? false;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => void load().catch(() => undefined), 10_000);
    return () => window.clearTimeout(timer);
  }, [load, waiting, reading]);

  if (loadError) {
    return <>{children({ available: true, row: <p className="awsLogStreaming__error" role="alert">{loadError}</p> })}</>;
  }
  if (reading === undefined) return <>{children({ available: true, row: <p className="awsLogStreaming__none" role="status">Loading…</p> })}</>;
  if (reading === null) return <>{children({ available: false, row: null })}</>;

  async function change(action: () => Promise<unknown>) {
    setSaving(true);
    setError("");
    try {
      await action();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return <>{children({
    available: true,
    row: <EnvironmentChips
      environments={reading.environments}
      error={error}
      onAdd={(environmentId) => void change(() => readRailwayEnvironment(integrationAccountId, environmentId))}
      onRemove={(source) => void change(() => removeTelemetrySource(source.id))}
      saving={saving}
      sources={reading.sources} />,
  })}</>;
}

// For places without a details table, such as the Settings Railway card.
export function RailwayLogReadingSettings({ integrationAccountId }: { integrationAccountId: string }) {
  return <RailwayLogReading integrationAccountId={integrationAccountId}>
    {({ available, row }) => available && row ? <div className="awsLogStreaming__row">
      <span className="awsLogStreaming__label">Telemetry from</span>
      {row}
    </div> : null}
  </RailwayLogReading>;
}

function EnvironmentChips({ environments, error, onAdd, onRemove, saving, sources }: {
  environments: RailwayEnvironmentOption[];
  error: string;
  onAdd: (environmentId: string) => void;
  onRemove: (source: TelemetrySourceSummary) => void;
  saving: boolean;
  sources: TelemetrySourceSummary[];
}) {
  const read = new Set(sources.map((source) => source.externalId));
  const addable = environments.filter((environment) => !read.has(environment.environmentId));
  const failures = sources.filter((source) => source.lastError && source.status === "failed");
  return <div className="awsLogStreaming__regions">
    <ul aria-label="Railway environments whose logs Superlog reads">
      {sources.map((source) => {
        const health = sourceHealth(source);
        return <li key={source.id} className="awsRegionChip" title={source.lastError ?? undefined}>
          <span>{source.displayName}</span>
          <span className={`awsRegionChip__status awsRegionChip__status--${health.tone}`}>{health.label}</span>
          <button
            aria-label={`Stop reading logs from ${source.displayName}`}
            className="awsRegionChip__remove"
            disabled={saving}
            onClick={() => onRemove(source)}
            type="button">
            <IconX aria-hidden="true" size={12} stroke={2} />
          </button>
        </li>;
      })}
      {addable.length > 0 && <li className="awsLogStreaming__item"><AddEnvironment disabled={saving} environments={addable} onAdd={onAdd} /></li>}
      {sources.length === 0 && addable.length === 0 && <li className="awsLogStreaming__item awsLogStreaming__none">This connection shares no environments</li>}
    </ul>
    {failures.map((source) => <p key={source.id} className="awsLogStreaming__error">{source.displayName}: {source.lastError}</p>)}
    {error && <p className="awsLogStreaming__error" role="alert">{error}</p>}
  </div>;
}

function AddEnvironment({ disabled, environments, onAdd }: {
  disabled: boolean;
  environments: RailwayEnvironmentOption[];
  onAdd: (environmentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const choose = (environmentId: string) => {
    setOpen(false);
    onAdd(environmentId);
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
      <IconPlus aria-hidden="true" size={13} stroke={2} />Add environment
    </button>
    {open && <ul aria-label="Railway environments" className="awsAddRegion__menu railwayEnvironmentMenu" role="listbox">
      {environments.map((environment) => <li key={environment.environmentId} aria-selected={false} role="option" tabIndex={0}
        onClick={() => choose(environment.environmentId)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(environment.environmentId); } }}>
        {environmentLabel(environment)}
      </li>)}
    </ul>}
  </div>;
}
