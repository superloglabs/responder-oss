import type { ReactNode } from "react";
import type { TelemetryProject } from "../telemetry-api";
import type { TelemetryProjectsState } from "../use-telemetry-projects";
import "./telemetry.css";

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

// Renders the page once the workspace has linked telemetry projects, and the
// loading, unavailable and empty states before that.
export function TelemetryProjectsGate({
  children,
  signal,
  state,
}: {
  children: (projects: TelemetryProject[]) => ReactNode;
  signal: "Logs" | "Traces";
  state: TelemetryProjectsState;
}) {
  if (state.projects === undefined) {
    return state.error ? (
      <div className="automationRuns__message" role="alert">
        <p>{state.error}</p>
        <button onClick={state.retry} type="button">Retry</button>
      </div>
    ) : (
      <p className="telemetryPage__status">Loading…</p>
    );
  }
  if (state.projects === null) {
    return (
      <section className="emptyState emptyState--list">
        <h2>{signal} are not available</h2>
        <p>This workspace cannot read telemetry yet.</p>
      </section>
    );
  }
  if (state.projects.length === 0) {
    return (
      <section className="emptyState emptyState--list">
        <h2>No telemetry projects</h2>
        <p>{signal} appear here once a telemetry project is linked to this workspace.</p>
      </section>
    );
  }
  return children(state.projects);
}
