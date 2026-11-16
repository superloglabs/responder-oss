import { useCallback, useEffect, useState, type ReactNode } from "react";
import { IconX } from "@tabler/icons-react";
import { removeTelemetrySource, sourceHealth, type TelemetrySourceSummary } from "../telemetry-sources-api";
import { AddChipMenu } from "./add-chip-menu";
// The chips reuse the AWS region chips.
import "./aws-log-streaming.css";

// What one connection's log reader can read, such as Railway environments or
// PostHog projects, and the sources Superlog already reads. Null when this
// workspace or cell cannot receive telemetry.
export interface LogReadingState {
  options: Array<{ label: string; value: string }>;
  sources: TelemetrySourceSummary[];
}

export interface LogReadingLabels {
  // "Add environment"
  add: string;
  // "This connection shares no environments"
  empty: string;
  // "Railway environments whose logs Superlog reads"
  list: string;
  // "Could not load Railway environments."
  loadFailed: string;
  // "Railway environments"
  menu: string;
}

// The value of a connection's "Telemetry from" row: the places whose logs
// the worker reads with the connection, as chips that can be removed, and a
// menu to add more. Where this workspace or cell cannot receive telemetry,
// `available` is false.
export interface LogReadingParts {
  available: boolean;
  row: ReactNode;
}

export function LogReading({ add, children, labels, load: loadState }: {
  add: (value: string) => Promise<unknown>;
  children: (parts: LogReadingParts) => ReactNode;
  labels: LogReadingLabels;
  load: () => Promise<LogReadingState | null>;
}) {
  // Undefined while loading; null when telemetry is not available here.
  const [reading, setReading] = useState<LogReadingState | null | undefined>(undefined);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const next = await loadState();
    setReading(next);
    setLoadError("");
  }, [loadState]);

  useEffect(() => {
    let current = true;
    loadState()
      .then((value) => { if (current) setReading(value); })
      .catch((failure: unknown) => { if (current) setLoadError(failure instanceof Error ? failure.message : labels.loadFailed); });
    return () => { current = false; };
  }, [loadState, labels.loadFailed]);

  // A new source shows "Waiting for data" until the worker's first read,
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
    row: <SourceChips
      error={error}
      labels={labels}
      onAdd={(value) => void change(() => add(value))}
      onRemove={(source) => void change(() => removeTelemetrySource(source.id))}
      options={reading.options}
      saving={saving}
      sources={reading.sources} />,
  })}</>;
}

// For places without a details table, such as a Settings integration card.
export function LogReadingRow(props: Omit<Parameters<typeof LogReading>[0], "children">) {
  return <LogReading {...props}>
    {({ available, row }) => available && row ? <div className="awsLogStreaming__row">
      <span className="awsLogStreaming__label">Telemetry from</span>
      {row}
    </div> : null}
  </LogReading>;
}

function SourceChips({ error, labels, onAdd, onRemove, options, saving, sources }: {
  error: string;
  labels: LogReadingLabels;
  onAdd: (value: string) => void;
  onRemove: (source: TelemetrySourceSummary) => void;
  options: LogReadingState["options"];
  saving: boolean;
  sources: TelemetrySourceSummary[];
}) {
  const read = new Set(sources.map((source) => source.externalId));
  const addable = options.filter((option) => !read.has(option.value));
  const failures = sources.filter((source) => source.lastError && source.status === "failed");
  return <div className="awsLogStreaming__regions">
    <ul aria-label={labels.list}>
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
      {addable.length > 0 && <li className="awsLogStreaming__item"><AddChipMenu
        disabled={saving}
        label={labels.add}
        menuClassName="logSourceMenu"
        menuLabel={labels.menu}
        onAdd={onAdd}
        options={addable} /></li>}
      {sources.length === 0 && addable.length === 0 && <li className="awsLogStreaming__item awsLogStreaming__none">{labels.empty}</li>}
    </ul>
    {failures.map((source) => <p key={source.id} className="awsLogStreaming__error">{source.displayName}: {source.lastError}</p>)}
    {error && <p className="awsLogStreaming__error" role="alert">{error}</p>}
  </div>;
}
