import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useIngestAvailable } from "../use-ingest-available";
import type { TelemetryAvailableState } from "../use-telemetry-available";
import { TelemetryPageSkeleton } from "./screen-skeletons";
import "./telemetry.css";

// Shown only where the workspace can send telemetry to this cell.
export function SendTelemetryLink({ variant }: { variant: "primary" | "secondary" }) {
  const available = useIngestAvailable();
  return available ? (
    <Link className={`dsButton dsButton--${variant} dsButton--small`} to="/telemetry/setup">Add telemetry</Link>
  ) : null;
}

export function TelemetryAttributes({ title, values }: { title: string; values: Record<string, string> }) {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <section className="telemetryDetail__section">
      <h3>{title}</h3>
      <dl className="telemetryDetail__attributes">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function TelemetryException({
  message,
  stacktrace,
  type,
}: {
  message: string;
  stacktrace: string;
  type: string;
}) {
  if (!type && !message && !stacktrace) return null;
  return (
    <section className="telemetryDetail__section">
      <h3>Exception</h3>
      {type || message ? (
        <p className="telemetryDetail__exception">{[type, message].filter(Boolean).join(": ")}</p>
      ) : null}
      {stacktrace ? <pre className="telemetryDetail__body">{stacktrace}</pre> : null}
    </section>
  );
}

// Renders the page once the workspace can read telemetry, and the loading
// and unavailable states before that. The skeleton should have the page's shape.
export function TelemetryGate({
  children,
  signal,
  skeleton = <TelemetryPageSkeleton />,
  state,
}: {
  children: ReactNode;
  signal: "AI models" | "Logs" | "Metrics" | "Telemetry" | "Traces";
  skeleton?: ReactNode;
  state: TelemetryAvailableState;
}) {
  if (state.available === undefined) {
    return state.error ? (
      <div className="automationRuns__message" role="alert">
        <p>{state.error}</p>
        <button onClick={state.retry} type="button">Retry</button>
      </div>
    ) : skeleton;
  }
  if (!state.available) {
    return (
      <section className="emptyState emptyState--list">
        <h2>{signal} {signal === "Telemetry" ? "is" : "are"} not available</h2>
        <p>This workspace cannot read telemetry yet.</p>
      </section>
    );
  }
  return children;
}
