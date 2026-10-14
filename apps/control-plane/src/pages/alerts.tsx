import { BellIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { fetchAlerts, type TelemetryAlertSummary } from "../alerts-api";
import { AppShell } from "../components/app-shell";
import { Badge, DataTable } from "../design-system";
import { describeAlertCondition, describeAlertRule } from "../../../../packages/core/src/telemetry/alert-text";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";
import "../components/alerts.css";

function AlertStatus({ alert }: { alert: TelemetryAlertSummary }) {
  if (!alert.enabled) return <Badge>Off</Badge>;
  if (alert.lastError) return <Badge tone="warning">Check failed</Badge>;
  if (alert.firingGroups > 0) {
    return <Badge tone="danger">{alert.groupMode === "per_group" ? `Firing · ${alert.firingGroups}` : "Firing"}</Badge>;
  }
  if (!alert.lastEvaluatedAt) return <Badge>Not checked yet</Badge>;
  return <Badge tone="live">OK</Badge>;
}

export function AlertsPage() {
  useDocumentTitle("Alerts");
  const navigate = useNavigate();
  // Undefined while loading; null when the workspace cannot use alerts.
  const [alerts, setAlerts] = useState<TelemetryAlertSummary[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAlerts(await fetchAlerts());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load alerts");
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const newAlert = (
    <Link className="dsButton dsButton--primary dsButton--small" to="/alerts/new">
      <PlusIcon size={12} />New alert
    </Link>
  );

  return (
    <AppShell active="alerts" redesigned>
      <header className="workspaceHeading">
        <h1><BellIcon aria-hidden="true" size={16} weight="bold" />Alerts</h1>
        {alerts && alerts.length > 0 ? <div className="workspaceHeading__actions">{newAlert}</div> : null}
      </header>
      {alerts === undefined ? (
        error ? (
          <div className="automationRuns__message" role="alert">
            <p>{error}</p>
            <button onClick={() => void load()} type="button">Retry</button>
          </div>
        ) : (
          <p className="telemetryPage__status">Loading…</p>
        )
      ) : alerts === null ? (
        <section className="emptyState emptyState--list">
          <h2>Alerts are not available</h2>
          <p>This workspace cannot use alerts yet.</p>
        </section>
      ) : alerts.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No alerts yet</h2>
          <p>Get a Slack message when errors, span counts or a metric cross a threshold, and another when they recover.</p>
          {newAlert}
        </section>
      ) : (
        <section aria-label="Alerts" className="automationRuns agentListTable">
          <DataTable<TelemetryAlertSummary>
            aria-label="Alerts"
            columns={[
              {
                header: "Alert",
                key: "name",
                render: (alert) => (
                  <span className="agentTableTitle">
                    <Link to={`/alerts/${alert.id}`}><strong>{alert.name}</strong></Link>
                    <small>
                      {describeAlertRule(alert)} {describeAlertCondition(alert.comparator, alert.threshold)}
                      {alert.groupMode === "per_group" && alert.groupBy ? `, per ${alert.groupBy.replace(/^attr:/u, "")}` : ""}
                    </small>
                  </span>
                ),
              },
              {
                header: "Status",
                key: "status",
                render: (alert) => <AlertStatus alert={alert} />,
                width: "140px",
              },
              {
                header: "Last checked",
                key: "checked",
                render: (alert) =>
                  alert.lastEvaluatedAt ? (
                    <time className="agentTableCell" dateTime={alert.lastEvaluatedAt} title={new Date(alert.lastEvaluatedAt).toLocaleString()}>
                      {relativeTime(alert.lastEvaluatedAt)}
                    </time>
                  ) : (
                    <span className="agentTableCell">—</span>
                  ),
                width: "140px",
              },
              {
                header: "",
                key: "open",
                render: () => <CaretRightIcon aria-hidden="true" className="automationRuns__open" size={14} />,
                width: "44px",
              },
            ]}
            getRowKey={(alert) => alert.id}
            onRowClick={(alert) => navigate(`/alerts/${alert.id}`)}
            rows={alerts}
            variant="workspace"
          />
        </section>
      )}
    </AppShell>
  );
}
