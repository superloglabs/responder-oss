import { ArrowClockwiseIcon, DotsThreeIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import ReactGridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { DashboardDialog } from "../components/dashboard-dialog";
import { DashboardVariableBar, DashboardVariablesEditor } from "../components/dashboard-variables";
import { DashboardWidgetBody } from "../components/dashboard-widget";
import { DashboardWidgetEditor } from "../components/dashboard-widget-editor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Button, IconButton, SegmentedControl, TextField } from "../design-system";
import {
  addWidget,
  changedLayouts,
  defaultVariableValues,
  deleteDashboard,
  deleteWidget,
  fetchDashboard,
  nextVariableValues,
  placeWidget,
  updateDashboard,
  updateLayout,
  updateWidget,
  type TelemetryDashboard,
  type TelemetryDashboardWidget,
  type WidgetDraft,
} from "../dashboards-api";
import { telemetryRanges, type TelemetryRange } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import "react-grid-layout/css/styles.css";
import "../components/automation-run-history.css";
import "../components/dashboards.css";
import "./automation-create.css";

const rangeValues = new Set<string>(telemetryRanges.map((range) => range.value));
// Below this width the grid stacks widgets in one column, without dragging.
const gridMinimumWidth = 720;

function minimumWidth(widget: TelemetryDashboardWidget): number {
  return widget.type === "log_table" || widget.type === "trace_table" ? 4 : 2;
}

type Editing = { widget: TelemetryDashboardWidget | null } | null;

// Measures its own width, so it renders only once there are widgets to place.
function DashboardGrid({
  onLayoutChange,
  renderWidget,
  widgets,
}: {
  onLayoutChange: (layout: Layout) => void;
  renderWidget: (widget: TelemetryDashboardWidget) => ReactNode;
  widgets: TelemetryDashboardWidget[];
}) {
  const { containerRef, mounted, width } = useContainerWidth();
  const stacked = [...widgets].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  return (
    <div className="dashboardPage__grid" ref={containerRef}>
      {mounted ? (
        width >= gridMinimumWidth ? (
          <ReactGridLayout
            dragConfig={{ cancel: ".dashboardWidget__actions, .dashboardWidget__body", handle: ".dashboardWidget__header" }}
            gridConfig={{ cols: 12, containerPadding: [0, 0], margin: [12, 12], rowHeight: 56 }}
            layout={widgets.map((widget) => ({ i: widget.id, ...widget.layout, minH: 2, minW: minimumWidth(widget) }))}
            onLayoutChange={onLayoutChange}
            width={width}
          >
            {widgets.map((widget) => <div key={widget.id}>{renderWidget(widget)}</div>)}
          </ReactGridLayout>
        ) : (
          <div className="dashboardPage__stack">
            {stacked.map((widget) => (
              <div key={widget.id} style={{ height: Math.max(3, widget.layout.h) * 56 }}>{renderWidget(widget)}</div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function WidgetTile({
  onDelete,
  onEdit,
  projectId,
  range,
  refresh,
  values,
  widget,
}: {
  onDelete: () => void;
  onEdit: () => void;
  projectId: string;
  range: TelemetryRange;
  refresh: number;
  values: Record<string, string>;
  widget: TelemetryDashboardWidget;
}) {
  return (
    <article aria-label={widget.title} className="dashboardWidget">
      <header className="dashboardWidget__header">
        <h2 className="dashboardWidget__handle" title={widget.title}>{widget.title}</h2>
        <div className="dashboardWidget__actions">
          <IconButton aria-label={`Edit ${widget.title}`} onClick={onEdit} size="small" variant="ghost">
            <PencilSimpleIcon size={13} />
          </IconButton>
          <IconButton aria-label={`Remove ${widget.title}`} onClick={onDelete} size="small" variant="ghost">
            <TrashIcon size={13} />
          </IconButton>
        </div>
      </header>
      <div className="dashboardWidget__body">
        <DashboardWidgetBody
          config={widget.config}
          projectId={projectId}
          range={range}
          refresh={refresh}
          title={widget.title}
          type={widget.type}
          variables={values}
        />
      </div>
    </article>
  );
}

export function DashboardPage() {
  const { dashboardId = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get("range") ?? "";
  const range: TelemetryRange = rangeValues.has(rangeParam) ? (rangeParam as TelemetryRange) : "1h";
  const [dashboard, setDashboard] = useState<TelemetryDashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [editingVariables, setEditingVariables] = useState(false);
  const [removing, setRemoving] = useState<TelemetryDashboardWidget | "dashboard" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Layout changes not yet saved, by widget.
  const pendingLayouts = useRef(new Map<string, TelemetryDashboardWidget["layout"]>());
  useDocumentTitle(dashboard ? `${dashboard.name} · Dashboards` : "Dashboards");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const loaded = await fetchDashboard(dashboardId);
      setDashboard(loaded);
      setValues(defaultVariableValues(loaded.variables));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Unable to load the dashboard");
    }
  }, [dashboardId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  // Saves layout changes still waiting for the debounce.
  const flushLayouts = useCallback((leaving = false) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (pendingLayouts.current.size === 0) return;
    const widgets = [...pendingLayouts.current].map(([id, layout]) => ({ id, layout }));
    pendingLayouts.current.clear();
    updateLayout(dashboardId, widgets, { keepalive: leaving }).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Unable to save the layout"),
    );
  }, [dashboardId]);

  // Leaving the page or closing the tab saves a move made just before.
  useEffect(() => {
    const leave = () => flushLayouts(true);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [flushLayouts]);

  // Saves moved and resized widgets, and the positions the grid settles new
  // widgets into.
  function onLayoutChange(layout: Layout) {
    if (!dashboard) return;
    const changes = changedLayouts(dashboard.widgets, [...layout]);
    if (changes.length === 0) return;
    const moved = new Map(changes.map((change) => [change.id, change.layout]));
    setDashboard({
      ...dashboard,
      widgets: dashboard.widgets.map((widget) => ({ ...widget, layout: moved.get(widget.id) ?? widget.layout })),
    });
    for (const change of changes) pendingLayouts.current.set(change.id, change.layout);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushLayouts(), 400);
  }

  async function saveWidget(draft: WidgetDraft) {
    if (!dashboard || !editing) return;
    const saved = editing.widget
      ? await updateWidget(dashboard.id, editing.widget.id, draft)
      : await addWidget(dashboard.id, {
          ...draft,
          layout: placeWidget(draft.type, dashboard.widgets.map((widget) => widget.layout)),
        });
    setDashboard((current) =>
      current
        ? {
            ...current,
            widgets: editing.widget
              ? current.widgets.map((widget) => (widget.id === saved.id ? saved : widget))
              : [...current.widgets, saved],
          }
        : current,
    );
    setEditing(null);
  }

  async function confirmRemove() {
    if (!dashboard || !removing) return;
    try {
      if (removing === "dashboard") {
        await deleteDashboard(dashboard.id);
        navigate("/dashboards");
        return;
      }
      await deleteWidget(dashboard.id, removing.id);
      setDashboard({ ...dashboard, widgets: dashboard.widgets.filter((widget) => widget.id !== removing.id) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to remove it");
    }
    setRemoving(null);
  }

  async function rename() {
    if (!dashboard || renaming === null) return;
    const name = renaming.trim();
    if (!name || name === dashboard.name) {
      setRenaming(null);
      return;
    }
    try {
      const updated = await updateDashboard(dashboard.id, { name });
      setDashboard({ ...dashboard, name: updated.name });
      setRenaming(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to rename the dashboard");
    }
  }

  if (!dashboard) {
    return (
      <AppShell active="dashboards" redesigned>
        {loadError ? (
          <div className="automationRuns__message" role="alert">
            <p>{loadError}</p>
            <button onClick={() => void load()} type="button">Retry</button>
          </div>
        ) : (
          <p className="telemetryPage__status">Loading…</p>
        )}
      </AppShell>
    );
  }

  const tiles = (widget: TelemetryDashboardWidget) => (
    <WidgetTile
      onDelete={() => setRemoving(widget)}
      onEdit={() => setEditing({ widget })}
      projectId={dashboard.projectId}
      range={range}
      refresh={refresh}
      values={values}
      widget={widget}
    />
  );

  return (
    <AppShell active="dashboards" redesigned>
      <div className="dashboardPage">
        <header className="automationCreate__header">
          <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb">
            <Link to="/dashboards">Dashboards</Link>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{dashboard.name}</span>
          </nav>
          <div className="dashboardPage__titleRow">
            {renaming === null ? (
              <h1>{dashboard.name}</h1>
            ) : (
              <form className="dashboardPage__rename" onSubmit={(event: FormEvent) => { event.preventDefault(); void rename(); }}>
                <TextField
                  autoFocus
                  label="Dashboard name"
                  maxLength={120}
                  onBlur={() => void rename()}
                  onChange={(event) => setRenaming(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }}
                  value={renaming}
                />
              </form>
            )}
            <span className="automationCreate__spacer" />
            <SegmentedControl
              aria-label="Time range"
              onChange={(value) => setParams((current) => {
                const next = new URLSearchParams(current);
                next.set("range", value);
                return next;
              }, { replace: true })}
              options={telemetryRanges}
              value={range}
            />
            <IconButton aria-label="Refresh" onClick={() => setRefresh((count) => count + 1)} size="small" variant="ghost">
              <ArrowClockwiseIcon size={14} />
            </IconButton>
            <Button onClick={() => setEditing({ widget: null })} size="small" variant="primary">
              <PlusIcon size={12} />Add widget
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton aria-label="Dashboard actions" size="small" variant="ghost">
                  <DotsThreeIcon size={16} weight="bold" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(dashboard.name)}>Rename</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEditingVariables(true)}>Variables</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setRemoving("dashboard")}>Delete dashboard</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {dashboard.projectName ? <p className="dashboardPage__meta">{dashboard.projectName}</p> : null}
        </header>
        <DashboardVariableBar
          onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
          values={values}
          variables={dashboard.variables}
        />
        {error ? <p className="formError" role="alert">{error}</p> : null}
        {dashboard.widgets.length === 0 ? (
          <section className="emptyState emptyState--list">
            <h2>No widgets yet</h2>
            <p>Add a chart of logs, spans or a metric, a table of recent logs or traces, or a note.</p>
            <Button onClick={() => setEditing({ widget: null })} size="small" variant="primary">
              <PlusIcon size={12} />Add widget
            </Button>
          </section>
        ) : null}
        {dashboard.widgets.length > 0 ? (
          <DashboardGrid onLayoutChange={onLayoutChange} renderWidget={tiles} widgets={dashboard.widgets} />
        ) : null}
      </div>
      {editing ? (
        <DashboardWidgetEditor
          initial={editing.widget}
          onClose={() => setEditing(null)}
          onSave={saveWidget}
          projectId={dashboard.projectId}
          range={range}
          variableValues={values}
          variables={dashboard.variables}
        />
      ) : null}
      {editingVariables ? (
        <DashboardVariablesEditor
          onClose={() => setEditingVariables(false)}
          onSave={async (variables) => {
            const updated = await updateDashboard(dashboard.id, { variables });
            setDashboard({ ...dashboard, variables: updated.variables });
            setValues((current) => nextVariableValues(updated.variables, current));
            setEditingVariables(false);
          }}
          variables={dashboard.variables}
        />
      ) : null}
      {removing ? (
        <DashboardDialog
          actions={
            <>
              <Button onClick={() => setRemoving(null)} variant="ghost">Cancel</Button>
              <Button onClick={() => void confirmRemove()} variant="danger">
                {removing === "dashboard" ? "Delete dashboard" : "Remove widget"}
              </Button>
            </>
          }
          onClose={() => setRemoving(null)}
          title={removing === "dashboard" ? `Delete ${dashboard.name}?` : `Remove ${removing.title}?`}
        >
          <p className="dashboardDialog__hint">
            {removing === "dashboard"
              ? "The dashboard and its widgets are deleted for everyone in the workspace."
              : "The widget is removed from this dashboard for everyone in the workspace."}
          </p>
        </DashboardDialog>
      ) : null}
    </AppShell>
  );
}
