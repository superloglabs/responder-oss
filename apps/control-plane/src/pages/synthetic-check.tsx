import { PencilSimpleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { ListSkeleton, SyntheticCheckSkeleton } from "../components/screen-skeletons";
import { DashboardDialog } from "../components/dashboard-dialog";
import { SyntheticRunDetails, SyntheticStatusBadge, UptimeStrip } from "../components/synthetics";
import { TimeseriesChart } from "../components/timeseries-chart";
import { Badge, Button, SegmentedControl } from "../design-system";
import {
  deleteSyntheticCheck,
  fetchSyntheticCheck,
  fetchSyntheticCheckRun,
  fetchSyntheticCheckRuns,
  formatUptime,
  intervalLabel,
  spanLabel,
  timingChart,
  uptimeSegments,
  type SyntheticCheckDetail,
  type SyntheticCheckRun,
  type SyntheticCheckRunSummary,
  type SyntheticRange,
} from "../synthetics-api";
import { formatDuration, formatTelemetryTime } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import "../components/alerts.css";
import "../components/dashboards.css";
import "../components/synthetics.css";
import "./automation-create.css";

const rangeOptions: Array<{ label: string; value: SyntheticRange }> = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];

function segmentTitle(segment: ReturnType<typeof uptimeSegments>[number], bucketSeconds: number): string {
  const start = new Date(segment.start);
  const end = new Date(segment.start + bucketSeconds * 1_000);
  const range = `${start.toLocaleString()} – ${end.toLocaleTimeString()}`;
  const runs = segment.passed + segment.degraded + segment.failed;
  if (runs === 0) return `${range}: no runs`;
  const parts = [
    segment.passed ? `${segment.passed} passed` : "",
    segment.degraded ? `${segment.degraded} degraded` : "",
    segment.failed ? `${segment.failed} failed` : "",
  ].filter(Boolean);
  return `${range}: ${parts.join(", ")}`;
}

function RunDialog({ checkId, onClose, run }: { checkId: string; onClose: () => void; run: SyntheticCheckRunSummary }) {
  const [detail, setDetail] = useState<{ run: SyntheticCheckRun } | { loadError: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchSyntheticCheckRun(checkId, run.id)
      .then((loaded) => { if (!cancelled) setDetail({ run: loaded }); })
      .catch((cause: unknown) => {
        if (!cancelled) setDetail({ loadError: cause instanceof Error ? cause.message : "Unable to load the run" });
      });
    return () => { cancelled = true; };
  }, [checkId, run.id]);
  return (
    <DashboardDialog
      actions={<Button onClick={onClose} variant="ghost">Close</Button>}
      onClose={onClose}
      title={`Run at ${new Date(run.startedAt).toLocaleString()}`}
      wide
    >
      <p className="dashboardDialog__hint">
        From {run.location}
        {run.attempts > 1 ? `, after ${run.attempts} attempts` : ""}.
      </p>
      {!detail ? (
        <ListSkeleton label="Loading run…" rows={6} />
      ) : "loadError" in detail ? (
        <p className="formError" role="alert">{detail.loadError}</p>
      ) : (
        <>
          <SyntheticRunDetails {...detail.run} />
          {detail.run.status === "passed" ? (
            <p className="dashboardDialog__hint">The response is kept only for runs that did not pass.</p>
          ) : null}
        </>
      )}
    </DashboardDialog>
  );
}

export function SyntheticCheckPage() {
  const { checkId = "" } = useParams();
  const navigate = useNavigate();
  const [range, setRange] = useState<SyntheticRange>("24h");
  // The check as loaded for a check and range, and when it was loaded.
  const [detail, setDetail] = useState<{ key: string; loadedAt: number; value: SyntheticCheckDetail } | null>(null);
  const [olderRuns, setOlderRuns] = useState<{ done: boolean; key: string; runs: SyntheticCheckRunSummary[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<SyntheticCheckRunSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const key = `${checkId}:${range}`;
  const current = detail?.key === key ? detail.value : null;
  // Kept while another range loads, so the page does not blank.
  const shown = current ?? (detail && detail.key.startsWith(`${checkId}:`) ? detail.value : null);
  const loadedAt = detail?.loadedAt ?? 0;
  useDocumentTitle(shown ? `${shown.check.name} · Synthetic checks` : "Synthetic checks");

  const latestKey = useRef(key);
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const loaded = await fetchSyntheticCheck(checkId, range);
      if (latestKey.current !== key) return;
      setDetail({ key, loadedAt: Date.now(), value: loaded });
    } catch (cause) {
      if (latestKey.current === key) setLoadError(cause instanceof Error ? cause.message : "Unable to load the check");
    }
  }, [checkId, key, range]);

  // Older runs are paged from the newest runs as loaded, so the page stops
  // refreshing once they are shown.
  const paging = olderRuns?.key === checkId;
  useEffect(() => {
    latestKey.current = key;
    void Promise.resolve().then(load);
    if (paging) return;
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [key, load, paging]);

  if (!shown) {
    return (
      <AppShell active="synthetics" redesigned>
        {loadError ? (
          <div className="automationRuns__message" role="alert">
            <p>{loadError}</p>
            <button onClick={() => void load()} type="button">Retry</button>
          </div>
        ) : (
          <SyntheticCheckSkeleton />
        )}
      </AppShell>
    );
  }

  const { check, episodes, stats } = shown;
  const segments = uptimeSegments(stats.buckets, shown.since, shown.bucketSeconds, loadedAt);
  const chart = timingChart(segments, stats.buckets, shown.bucketSeconds);
  const hasTimings = stats.buckets.some((bucket) => bucket.averageMs);
  const extra = paging ? olderRuns : null;
  const shownIds = new Set(shown.runs.map((run) => run.id));
  const runs = [...shown.runs, ...(extra?.runs ?? []).filter((run) => !shownIds.has(run.id))];
  const failing = check.lastStatus === "failed";

  async function loadMore() {
    const last = runs.at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const more = await fetchSyntheticCheckRuns(checkId, last);
      setOlderRuns({ done: more.length < 50, key: checkId, runs: [...(extra?.runs ?? []), ...more] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load more runs");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppShell active="synthetics" redesigned>
      <div className="syntheticCheck">
        <header className="automationCreate__header">
          <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb">
            <Link to="/synthetics">Synthetic checks</Link>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{check.name}</span>
          </nav>
          <div className="dashboardPage__titleRow">
            <h1>{check.name}</h1>
            {!check.enabled ? <Badge>Off</Badge> : check.lastStatus ? <SyntheticStatusBadge status={check.lastStatus} /> : <Badge>Not run yet</Badge>}
            <span className="automationCreate__spacer" />
            <SegmentedControl aria-label="Time range" onChange={setRange} options={rangeOptions} value={range} />
            <Button onClick={() => setDeleting(true)} size="small" variant="ghost">Delete</Button>
            <Link className="dsButton dsButton--secondary dsButton--small" to={`/synthetics/${check.id}/edit`}>
              <PencilSimpleIcon size={12} />Edit
            </Link>
          </div>
          <p className="syntheticCheck__target">
            <span className="syntheticCheck__method">{check.method}</span>
            <code>{check.url}</code>
          </p>
          <p className="dashboardPage__meta">
            {intervalLabel(check.intervalSeconds)}
            {check.lastRunAt ? ` · Last run ${relativeTime(check.lastRunAt)}` : ""}
            {runs[0] ? ` · From ${runs[0].location}` : ""}
          </p>
        </header>
        {error ? <p className="formError" role="alert">{error}</p> : null}

        <dl className="syntheticCheck__stats">
          <div className="syntheticCheck__stat">
            <dt>Uptime</dt>
            <dd>{formatUptime(stats.uptime)}</dd>
          </div>
          <div className="syntheticCheck__stat">
            <dt>Average duration</dt>
            <dd>{stats.averageDurationMs === null ? "—" : formatDuration(stats.averageDurationMs)}</dd>
          </div>
          <div className="syntheticCheck__stat">
            <dt>95th percentile</dt>
            <dd>{stats.p95DurationMs === null ? "—" : formatDuration(stats.p95DurationMs)}</dd>
          </div>
          <div className="syntheticCheck__stat">
            <dt>{failing ? "Down for" : "Up for"}</dt>
            <dd>{check.enabled && check.statusSince && check.lastStatus ? spanLabel(loadedAt - Date.parse(check.statusSince)) : "—"}</dd>
          </div>
        </dl>

        <section aria-label="Runs over time" className="syntheticCheck__section">
          <header>
            <h2>Runs</h2>
            <span className="dashboardPage__meta">{stats.runs.toLocaleString()} in the last {range === "24h" ? "day" : range === "7d" ? "7 days" : "30 days"}</span>
          </header>
          <div>
            <UptimeStrip
              label="Run results over time"
              segments={segments}
              title={(index) => segmentTitle(segments[index]!, shown.bucketSeconds)}
            />
            <div aria-hidden="true" className="uptimeStrip__axis">
              <span>{new Date(shown.since).toLocaleString(undefined, { day: "numeric", hour: "2-digit", minute: "2-digit", month: "short" })}</span>
              <span>Now</span>
            </div>
          </div>
        </section>

        <section aria-label="Duration" className="syntheticCheck__section">
          <header>
            <h2>Duration by phase</h2>
            <span className="dashboardPage__meta">Average of the runs that did not fail</span>
          </header>
          <div className="syntheticCheck__chart">
            {hasTimings ? (
              <TimeseriesChart chart={chart} chartType="bar" label="Duration by phase" unit="duration_ms" />
            ) : (
              <p className="dashboardWidget__status">No successful runs in this range.</p>
            )}
          </div>
        </section>

        <section aria-label="Latest runs" className="syntheticCheck__section">
          <header><h2>Latest runs</h2></header>
          {runs.length === 0 ? (
            <p className="dashboardWidget__status">The check has not run yet.</p>
          ) : (
            <>
              <table className="dashboardWidget__table syntheticCheck__runs">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Result</th>
                    <th className="dashboardWidget__number" scope="col">Status code</th>
                    <th className="dashboardWidget__number" scope="col">Duration</th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr
                      key={run.id}
                      onClick={() => setOpenRun(run)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setOpenRun(run);
                        }
                      }}
                      tabIndex={0}
                    >
                      <td className="dashboardWidget__muted" title={new Date(run.startedAt).toLocaleString()}>{formatTelemetryTime(run.startedAt)}</td>
                      <td><SyntheticStatusBadge status={run.status} /></td>
                      <td className="dashboardWidget__number">{run.statusCode ?? "—"}</td>
                      <td className="dashboardWidget__number">{formatDuration(run.durationMs)}</td>
                      <td className="dashboardWidget__muted" title={run.error ?? undefined}>{run.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!extra?.done && runs.length >= 50 ? (
                <Button className="syntheticCheck__more" loading={loadingMore} onClick={() => void loadMore()} size="small" variant="ghost">
                  Show older runs
                </Button>
              ) : null}
            </>
          )}
        </section>

        <section aria-label="Failures" className="syntheticCheck__section">
          <header><h2>Failures</h2></header>
          {episodes.length === 0 ? (
            <p className="dashboardWidget__status">
              {`The check has not alerted yet. It alerts after ${check.failuresToAlert === 1 ? "a failed run" : `${check.failuresToAlert} failed runs in a row`}.`}
            </p>
          ) : (
            <table className="dashboardWidget__table alertEpisodes">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">State</th>
                  <th className="dashboardWidget__number" scope="col">Lasted</th>
                  <th className="dashboardWidget__number" scope="col">Failed runs</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {episodes.map((episode) => (
                  <tr key={episode.id}>
                    <td className="dashboardWidget__muted" title={new Date(episode.startedAt).toLocaleString()}>{formatTelemetryTime(episode.startedAt)}</td>
                    <td>{episode.state === "failing" ? <Badge tone="danger">Failing</Badge> : <Badge>Recovered</Badge>}</td>
                    <td className="dashboardWidget__number">
                      {episode.endedAt ? formatDuration(Date.parse(episode.endedAt) - Date.parse(episode.startedAt)) : "—"}
                    </td>
                    <td className="dashboardWidget__number">{episode.failedRuns}</td>
                    <td className="dashboardWidget__muted" title={episode.reason}>{episode.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      {openRun ? <RunDialog checkId={check.id} onClose={() => setOpenRun(null)} run={openRun} /> : null}
      {deleting ? (
        <DashboardDialog
          actions={
            <>
              <Button onClick={() => setDeleting(false)} variant="ghost">Cancel</Button>
              <Button
                onClick={() => {
                  void deleteSyntheticCheck(check.id)
                    .then(() => navigate("/synthetics"))
                    .catch((cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : "Unable to delete the check");
                      setDeleting(false);
                    });
                }}
                variant="danger"
              >
                Delete check
              </Button>
            </>
          }
          onClose={() => setDeleting(false)}
          title={`Delete ${check.name}?`}
        >
          <p className="dashboardDialog__hint">The check stops running and its history is deleted.</p>
        </DashboardDialog>
      ) : null}
    </AppShell>
  );
}
