import { NavigationIcon } from "../components/navigation-icon";
import { CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { DataTableSkeleton } from "../components/screen-skeletons";
import { DashboardDialog } from "../components/dashboard-dialog";
import { Button, DataTable, TextField } from "../design-system";
import { createDashboard, fetchDashboards, type TelemetryDashboardSummary } from "../dashboards-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryAvailable } from "../use-telemetry-available";
import "../components/automation-run-history.css";
import "../components/dashboards.css";

function NewDashboardDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (saving) return;
    if (!name.trim()) {
      setError("Name the dashboard.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const dashboard = await createDashboard({ name: name.trim() });
      navigate(`/dashboards/${dashboard.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the dashboard");
      setSaving(false);
    }
  }

  return (
    <DashboardDialog
      actions={
        <>
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button loading={saving} onClick={() => void submit()} variant="primary">Create dashboard</Button>
        </>
      }
      onClose={onClose}
      title="New dashboard"
    >
      <form className="dashboardDialog__form" onSubmit={(event) => void submit(event)}>
        <TextField autoFocus label="Name" maxLength={120} onChange={(event) => setName(event.target.value)} value={name} />
        {error ? <p className="formError" role="alert">{error}</p> : null}
      </form>
    </DashboardDialog>
  );
}

export function DashboardsPage() {
  useDocumentTitle("Dashboards");
  const navigate = useNavigate();
  const telemetry = useTelemetryAvailable();
  // Undefined while loading; null when the workspace cannot use dashboards.
  const [dashboards, setDashboards] = useState<TelemetryDashboardSummary[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDashboards(await fetchDashboards());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load dashboards");
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const canCreate = telemetry.available === true;
  // Until telemetry is known to be readable, creating a dashboard is not possible.
  const telemetryError = telemetry.error ? (
    <div className="automationRuns__message" role="alert">
      <p>{telemetry.error}</p>
      <button onClick={telemetry.retry} type="button">Retry</button>
    </div>
  ) : null;
  const newButton = canCreate ? (
    <Button onClick={() => setCreating(true)} size="small" variant="primary">
      <PlusIcon size={12} />New dashboard
    </Button>
  ) : null;

  return (
    <AppShell active="dashboards" redesigned>
      <header className="workspaceHeading">
        <h1><NavigationIcon section="dashboards" />Dashboards</h1>
        {dashboards && dashboards.length > 0 ? <div className="workspaceHeading__actions">{newButton}</div> : null}
      </header>
      {telemetryError}
      {dashboards === undefined ? (
        error ? (
          <div className="automationRuns__message" role="alert">
            <p>{error}</p>
            <button onClick={() => void load()} type="button">Retry</button>
          </div>
        ) : (
          <DataTableSkeleton
            columns={[
              { header: "Dashboard", key: "name" },
              { align: "right", header: "Widgets", key: "widgets", width: "96px" },
              { header: "Updated", key: "updated", width: "140px" },
              { cell: "empty", header: "", key: "open", width: "44px" },
            ]}
            label="Loading dashboards…"
          />
        )
      ) : dashboards === null ? (
        <section className="emptyState emptyState--list">
          <h2>Dashboards are not available</h2>
          <p>This workspace cannot use dashboards yet.</p>
        </section>
      ) : dashboards.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No dashboards yet</h2>
          <p>
            {canCreate || telemetry.available === undefined
              ? "Chart logs, spans and metrics from this workspace's telemetry."
              : "This workspace cannot read telemetry yet."}
          </p>
          {newButton}
        </section>
      ) : (
        <section aria-label="Dashboards" className="automationRuns agentListTable">
          <DataTable<TelemetryDashboardSummary>
            aria-label="Dashboards"
            columns={[
              {
                header: "Dashboard",
                key: "name",
                render: (dashboard) => (
                  <span className="agentTableTitle">
                    <Link to={`/dashboards/${dashboard.id}`}><strong>{dashboard.name}</strong></Link>
                  </span>
                ),
              },
              {
                align: "right",
                header: "Widgets",
                key: "widgets",
                render: (dashboard) => <span className="agentTableCell">{dashboard.widgetCount}</span>,
                width: "96px",
              },
              {
                header: "Updated",
                key: "updated",
                render: (dashboard) => (
                  <time className="agentTableCell" dateTime={dashboard.updatedAt} title={new Date(dashboard.updatedAt).toLocaleString()}>
                    {relativeTime(dashboard.updatedAt)}
                  </time>
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
            getRowKey={(dashboard) => dashboard.id}
            onRowClick={(dashboard) => navigate(`/dashboards/${dashboard.id}`)}
            rows={dashboards}
            variant="workspace"
          />
        </section>
      )}
      {creating ? <NewDashboardDialog onClose={() => setCreating(false)} /> : null}
    </AppShell>
  );
}
