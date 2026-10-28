import { BracketsCurlyIcon, CheckIcon, DotsThreeIcon, FileCodeIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactGridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { DashboardSkeleton } from "../components/screen-skeletons";
import { copyTerraformLabel, useCopyTerraform } from "../use-copy-terraform";
import { DashboardDialog } from "../components/dashboard-dialog";
import { DashboardTimePicker } from "../components/dashboard-time-picker";
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
import { Button, IconButton, TextField } from "../design-system";
import {
  isLive,
  liveRefreshInterval,
  timeRangeFromParams,
  timeRangeParams,
  zoomOutTimeRange,
  type DashboardTimeRange,
} from "../dashboard-time-range";
import {
  addWidget,
  changedLayouts,
  deleteDashboard,
  deleteWidget,
  fetchDashboard,
  nextVariableValues,
  placeWidget,
  updateDashboard,
  updateLayout,
  updateWidget,
  variableParams,
  variableValuesFromParams,
  type TelemetryDashboard,
  type TelemetryDashboardWidget,
  type VariableValues,
  type WidgetDraft,
} from "../dashboards-api";
import { useDocumentTitle } from "../use-document-title";
import { useTimeZonePreference } from "../use-time-zone-preference";
import "react-grid-layout/css/styles.css";
import "../components/automation-run-history.css";
import "../components/dashboards.css";
import "./automation-create.css";

// Below this width the grid stacks widgets in one column, without dragging.
const gridMinimumWidth = 720;

function minimumWidth(widget: TelemetryDashboardWidget): number {
  return widget.type === "log_table" || widget.type === "trace_table" ? 4 : 2;
}

type Editing = { widget: TelemetryDashboardWidget | null } | null;

// Measures its own width, so it renders only once there are widgets to place.
// Widgets first render at the measured width, so charts draw once.
function DashboardGrid({
  onLayoutChange,
  renderWidget,
  widgets,
}: {
  onLayoutChange: (layout: Layout) => void;
  renderWidget: (widget: TelemetryDashboardWidget) => ReactNode;
  widgets: TelemetryDashboardWidget[];
}) {
  const { containerRef, mounted, width } = useContainerWidth({ measureBeforeMount: true });
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
  onZoom,
  range,
  refresh,
  timeZone,
  values,
  widget,
}: {
  onDelete: () => void;
  onEdit: () => void;
  onZoom: (since: number, until: number) => void;
  range: DashboardTimeRange;
  refresh: number;
  timeZone: string;
  values: VariableValues;
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
          onZoom={onZoom}
          range={range}
          refresh={refresh}
          timeZone={timeZone}
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
  const rangeKey = ["range", "from", "to"].map((name) => params.get(name) ?? "").join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the range changes only with its own parameters.
  const range = useMemo(() => timeRangeFromParams(params), [rangeKey]);
  // The range before someone zoomed into a chart, which zooming out returns to.
  const [zoomedFrom, setZoomedFrom] = useState<DashboardTimeRange | null>(null);
  const { changeTimeZone, timeZone, timeZonePreference } = useTimeZonePreference();
  const [now, setNow] = useState(() => Date.now());
  const [dashboard, setDashboard] = useState<TelemetryDashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<VariableValues>({});
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [editingVariables, setEditingVariables] = useState(false);
  const [removing, setRemoving] = useState<TelemetryDashboardWidget | "dashboard" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Layout changes not yet saved, by widget.
  const pendingLayouts = useRef(new Map<string, TelemetryDashboardWidget["layout"]>());
  const layoutSaves = useRef<Promise<void>>(Promise.resolve());
  useDocumentTitle(dashboard ? `${dashboard.name} · Dashboards` : "Dashboards");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const loaded = await fetchDashboard(dashboardId);
      setDashboard(loaded);
      setValues(variableValuesFromParams(loaded.variables, new URLSearchParams(window.location.search)));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Unable to load the dashboard");
    }
  }, [dashboardId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  // A live range reloads every widget on its own while the page is visible,
  // and the header's times follow now.
  useEffect(() => {
    if (!isLive(range)) return;
    const reload = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      setRefresh((count) => count + 1);
    }, liveRefreshInterval(range, Date.now()));
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(reload);
      clearInterval(clock);
    };
  }, [range]);

  const changeRange = useCallback((next: DashboardTimeRange, zoomed: DashboardTimeRange | null = null) => {
    setZoomedFrom(zoomed);
    setNow(Date.now());
    setParams((current) => timeRangeParams(next, current), { replace: true });
  }, [setParams]);

  // Dragging across a chart shows that window, at least a minute long.
  const zoomInto = useCallback((since: number, until: number) => {
    const current = Date.now();
    const centre = (since + until) / 2;
    const from = Math.round(Math.min(since, centre - 30_000));
    const to = Math.min(current, Math.round(Math.max(until, centre + 30_000)));
    if (to <= from) return;
    changeRange({ from, kind: "absolute", to }, zoomedFrom ?? range);
  }, [changeRange, range, zoomedFrom]);

  function changeValues(next: VariableValues) {
    setValues(next);
    setParams((current) => variableParams(next, current), { replace: true });
  }

  // Saves layout changes still waiting for the debounce. Saves run one after
  // another, so the latest layout is the one stored; leaving the page sends
  // at once, since the page may be gone before an earlier save ends. Resolves
  // once every save started so far has finished.
  const flushLayouts = useCallback((leaving = false): Promise<void> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (pendingLayouts.current.size > 0) {
      const widgets = [...pendingLayouts.current].map(([id, layout]) => ({ id, layout }));
      pendingLayouts.current.clear();
      const save = () =>
        updateLayout(dashboardId, widgets, { keepalive: leaving }).then(
          () => undefined,
          (cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to save the layout"),
        );
      layoutSaves.current = leaving
        ? Promise.all([layoutSaves.current, save()]).then(() => undefined)
        : layoutSaves.current.then(save);
    }
    return layoutSaves.current;
  }, [dashboardId]);
  // Exports the layout on screen, including a move still being saved.
  const [terraformState, copyTerraform] = useCopyTerraform({ dashboardIds: [dashboardId] }, flushLayouts);

  // Leaving the page or closing the tab saves a move made just before.
  useEffect(() => {
    const leave = () => void flushLayouts(true);
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
    saveTimer.current = setTimeout(() => void flushLayouts(), 400);
  }

  async function saveWidget(draft: WidgetDraft) {
    if (!dashboard || !editing) return;
    const saved = editing.widget
      ? await updateWidget(dashboard.id, editing.widget.id, draft)
      : await addWidget(dashboard.id, {
          ...draft,
          layout: placeWidget(draft.type, dashboard.widgets.map((widget) => widget.layout), draft.config.display),
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
      <AppShell active="dashboards" density={loadError ? "default" : "dashboard"} redesigned>
        {loadError ? (
          <div className="automationRuns__message" role="alert">
            <p>{loadError}</p>
            <button onClick={() => void load()} type="button">Retry</button>
          </div>
        ) : (
          <DashboardSkeleton />
        )}
      </AppShell>
    );
  }

  const tiles = (widget: TelemetryDashboardWidget) => (
    <WidgetTile
      onDelete={() => setRemoving(widget)}
      onEdit={() => setEditing({ widget })}
      onZoom={zoomInto}
      range={range}
      refresh={refresh}
      timeZone={timeZone}
      values={values}
      widget={widget}
    />
  );

  return (
    <AppShell active="dashboards" density="dashboard" redesigned>
      <div className="dashboardPage">
        <header className="dashboardPage__controls">
          <div className="dashboardPage__column automationCreate__header">
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
              <DashboardTimePicker
                now={now}
                onChange={(next) => changeRange(next)}
                onTimeZoneChange={changeTimeZone}
                onZoomOut={() => {
                  const zoomed = zoomOutTimeRange(range, Date.now(), zoomedFrom);
                  changeRange(zoomed.range, zoomed.zoomedFrom);
                }}
                range={range}
                timeZone={timeZone}
                timeZonePreference={timeZonePreference}
                zoomed={zoomedFrom !== null}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton aria-label="Dashboard actions" size="small" variant="ghost">
                    <DotsThreeIcon size={16} weight="bold" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setRenaming(dashboard.name)}>
                    <PencilSimpleIcon />Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setEditingVariables(true)}>
                    <BracketsCurlyIcon />{dashboard.variables.length > 0 ? "Variables" : "Add variable"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      // Stays open to show that the copy worked.
                      event.preventDefault();
                      copyTerraform();
                    }}
                  >
                    {terraformState === "copied" ? <CheckIcon /> : <FileCodeIcon />}{copyTerraformLabel(terraformState)}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setRemoving("dashboard")} variant="destructive">
                    <TrashIcon />Delete dashboard
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>
        <div className="dashboardPage__canvas">
          <div className="dashboardPage__column">
            <div className="dashboardPage__toolbar">
              <DashboardVariableBar
                onChange={(name, value) => changeValues({ ...values, [name]: value })}
                range={range}
                values={values}
                variables={dashboard.variables}
              />
              <span className="automationCreate__spacer" />
              <Button onClick={() => setEditing({ widget: null })} size="small" variant="primary">
                <PlusIcon size={12} />Add widget
              </Button>
            </div>
            {error ? <p className="formError" role="alert">{error}</p> : null}
            {dashboard.widgets.length === 0 ? (
              <section className="emptyState emptyState--list">
                <h2>No widgets yet</h2>
                <p>Add a chart of logs, spans or a metric, a table of recent logs or traces, or a note.</p>
              </section>
            ) : null}
            {dashboard.widgets.length > 0 ? (
              <DashboardGrid onLayoutChange={onLayoutChange} renderWidget={tiles} widgets={dashboard.widgets} />
            ) : null}
          </div>
        </div>
      </div>
      {editing ? (
        <DashboardWidgetEditor
          initial={editing.widget}
          onClose={() => setEditing(null)}
          onSave={saveWidget}
          range={range}
          timeZone={timeZone}
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
            changeValues(nextVariableValues(updated.variables, values));
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
