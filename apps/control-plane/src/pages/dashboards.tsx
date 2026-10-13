import { CaretRightIcon, ChartLineIcon, PlusIcon } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { DashboardDialog } from "../components/dashboard-dialog";
import { Button, DataTable, SelectField, TextField } from "../design-system";
import { createDashboard, fetchDashboards, type TelemetryDashboardSummary } from "../dashboards-api";
import type { TelemetryProject } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryProjects } from "../use-telemetry-projects";
import "../components/automation-run-history.css";
import "../components/dashboards.css";

function NewDashboardDialog({ onClose, projects }: { onClose: () => void; projects: TelemetryProject[] }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.projectId ?? "");
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
      const dashboard = await createDashboard({ name: name.trim(), projectId });
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
        {projects.length > 1 ? (
          <SelectField
            label="Project"
            onChange={setProjectId}
            options={projects.map((project) => ({ label: project.name, value: project.projectId }))}
            value={projectId}
          />
        ) : null}
        {error ? <p className="formError" role="alert">{error}</p> : null}
      </form>
    </DashboardDialog>
  );
}

export function DashboardsPage() {
  useDocumentTitle("Dashboards");
  const navigate = useNavigate();
  const telemetry = useTelemetryProjects();
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

  const projects = telemetry.projects ?? [];
  const canCreate = projects.length > 0;
  // Without the project list, creating a dashboard is not possible yet.
  const projectsError = telemetry.error ? (
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
        <h1><ChartLineIcon aria-hidden="true" size={16} weight="bold" />Dashboards</h1>
        {dashboards && dashboards.length > 0 ? <div className="workspaceHeading__actions">{newButton}</div> : null}
      </header>
      {projectsError}
      {dashboards === undefined ? (
        error ? (
          <div className="automationRuns__message" role="alert">
            <p>{error}</p>
            <button onClick={() => void load()} type="button">Retry</button>
          </div>
        ) : (
          <p className="telemetryPage__status">Loading…</p>
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
            {canCreate || telemetry.projects === undefined
              ? "Chart logs, spans and metrics from your telemetry projects."
              : "Dashboards need a telemetry project linked to this workspace."}
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
                    {projects.length > 1 ? <small>{dashboard.projectName}</small> : null}
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
      {creating ? <NewDashboardDialog onClose={() => setCreating(false)} projects={projects} /> : null}
    </AppShell>
  );
}
