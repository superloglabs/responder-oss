import { CaretRightIcon, CodeIcon, PlusCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { ProviderGlyph } from "../components/icons";
import { Badge } from "../design-system";
import { fetchTelemetrySources, type TelemetrySourceOverview } from "../telemetry-sources-api";
import { telemetrySourceOptions } from "../telemetry-source-options";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";
import "../components/telemetry.css";

// Lists the ways to send telemetry. Each opens its own setup page.
export function TelemetrySetupPage() {
  useDocumentTitle("Add telemetry");
  // Undefined while loading; null when the cell does not accept telemetry.
  const [overview, setOverview] = useState<TelemetrySourceOverview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await fetchTelemetrySources());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load telemetry sources");
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return (
    <AppShell active="telemetry-overview" redesigned>
      <header className="workspaceHeading">
        <h1><PlusCircleIcon aria-hidden="true" size={16} weight="bold" />Add telemetry</h1>
      </header>
      {overview === undefined ? (
        error ? (
          <div className="automationRuns__message" role="alert">
            <p>{error}</p>
            <button onClick={() => { setError(null); void load(); }} type="button">Retry</button>
          </div>
        ) : (
          <p className="telemetryPage__status">Loading…</p>
        )
      ) : overview === null ? (
        <section className="emptyState emptyState--list">
          <h2>Sending telemetry is not available</h2>
          <p>This workspace cannot receive telemetry in this region yet.</p>
        </section>
      ) : (
        <div className="telemetrySetup">
          <Link className="telemetrySetup__back" to="/telemetry">← Overview</Link>
          <p className="telemetrySetup__intro">
            Send logs, traces and metrics to this workspace. They appear in <Link to="/logs">Logs</Link>,{" "}
            <Link to="/traces">Traces</Link> and <Link to="/metrics">Metrics</Link>.
          </p>
          <ul aria-label="Telemetry sources" className="telemetrySources">
            {telemetrySourceOptions.map((option) => {
              const connected = overview.sources.filter((source) => source.provider === option.id).length;
              return (
                <li key={option.id}>
                  <Link className="telemetrySources__row" to={`/telemetry/setup/${option.id}`}>
                    {option.id === "opentelemetry" ? (
                      <CodeIcon aria-hidden="true" className="telemetrySources__icon" size={20} />
                    ) : (
                      <ProviderGlyph decorative provider={option.id} />
                    )}
                    <span className="telemetrySources__body">
                      <strong>{option.title}</strong>
                      <span>{option.description}</span>
                    </span>
                    {connected > 0 ? <Badge tone="live">{connected} connected</Badge> : <span />}
                    <CaretRightIcon aria-hidden="true" className="telemetrySources__chevron" size={16} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </AppShell>
  );
}
