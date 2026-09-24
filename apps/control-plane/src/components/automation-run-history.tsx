import { XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelAutomationRun,
  fetchAutomationRuns,
  type AutomationRunPage,
  type AutomationRunSummary,
} from "../automations-api";
import { dateGroupLabel } from "../date-presentation";
import { DataTable } from "../design-system";
import { providerDisplayName } from "./provider-glyphs";
import "./automation-run-history.css";

const statusLabels = {
  cancelled: "Cancelled",
  failed: "Failed",
  pending: "Queued",
  running: "Running",
  succeeded: "Completed",
} as const;

function isActive(run: AutomationRunSummary) {
  return run.status === "pending" || run.status === "running";
}

function startedLabel(value: string): string {
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", hourCycle: "h23", minute: "2-digit" }).format(new Date(value));
  const day = dateGroupLabel(value);
  if (day === "Today" || day === "Yesterday") return `${day}, ${time}`;
  return `${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(value))}, ${time}`;
}

function durationLabel(run: AutomationRunSummary, now: number): string {
  if (!run.startedAt) return "—";
  const end = run.completedAt ? new Date(run.completedAt).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function resultDetail(run: AutomationRunSummary): string {
  if (run.failureMessage) return run.failureMessage;
  if (run.resultSummary) return run.resultSummary;
  if (run.status === "pending") return "Waiting for a worker";
  if (run.status === "running") return "Running in sandbox";
  if (run.status === "cancelled") return "Stopped before finishing";
  return "No summary";
}

function providerLabel(provider: string): string {
  return provider === "manual" ? "Manual" : providerDisplayName(provider);
}

export function AutomationRunHistory({ automationId, refreshKey }: { automationId: string; refreshKey: number }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AutomationRunPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const request = useRef(0);

  const load = useCallback(async () => {
    const generation = ++request.current;
    try {
      const loaded = await fetchAutomationRuns(automationId, page);
      if (request.current !== generation) return;
      setResult(loaded);
      setNow(Date.now());
      setError(null);
    } catch (cause) {
      if (request.current === generation) setError(cause instanceof Error ? cause.message : "Unable to load runs");
    }
  }, [automationId, page]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load, refreshKey]);

  // Active runs change status and duration, so keep the page current.
  const hasActiveRun = result?.runs.some(isActive) ?? false;
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, load]);

  async function cancel(run: AutomationRunSummary) {
    setCancelling(run.id);
    try {
      await cancelAutomationRun(run.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to cancel run");
    } finally {
      setCancelling(null);
    }
  }

  if (!result) {
    return error
      ? <p className="automationRuns__message" role="alert">{error}</p>
      : <p className="automationRuns__message" role="status">Loading runs…</p>;
  }

  const first = (result.page - 1) * result.pageSize;
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));

  return <section className="automationRuns agentListTable" aria-label="Run history">
    {error ? <p className="formError" role="alert">{error}</p> : null}
    <DataTable<AutomationRunSummary>
      aria-label="Automation runs"
      columns={[
        {
          header: "Run",
          key: "run",
          render: (run) => <span className="agentTableTitle">
            {run.trigger.sourceUrl
              ? <a href={run.trigger.sourceUrl} rel="noreferrer" target="_blank"><strong>{run.trigger.title}</strong></a>
              : <strong>{run.trigger.title}</strong>}
            <small>Run #{run.number} · {providerLabel(run.trigger.provider)}</small>
          </span>,
          width: "52%",
        },
        {
          header: "Started",
          key: "started",
          render: (run) => <time className="agentTableCell" dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>{startedLabel(run.createdAt)}</time>,
          width: "16%",
        },
        { header: "Duration", key: "duration", render: (run) => <span className="agentTableCell">{durationLabel(run, now)}</span>, width: "9.5%" },
        {
          header: "Result",
          key: "result",
          render: (run) => <span className="agentTableRun">
            <span className={`automationRuns__status automationRuns__status--${run.status}`}><i aria-hidden="true" />{statusLabels[run.status]}</span>
            <small title={resultDetail(run)}>{resultDetail(run)}</small>
          </span>,
          width: "18%",
        },
        {
          header: "",
          key: "actions",
          render: (run) => isActive(run) ? <button aria-label={`Cancel run #${run.number}`} className="automationRuns__cancel" disabled={cancelling !== null} onClick={() => void cancel(run)} title="Cancel run" type="button"><XIcon size={14} /></button> : null,
          width: "44px",
        },
      ]}
      emptyMessage="No runs yet. A run starts when the trigger fires."
      getRowKey={(run) => run.id}
      rows={result.runs}
      variant="workspace"
    />
    {result.total > 0 ? <footer className="automationRuns__footer">
      <span>Showing {first + 1}–{first + result.runs.length} of {result.total} {result.total === 1 ? "run" : "runs"}</span>
      <div>
        <button disabled={result.page <= 1} onClick={() => setPage(result.page - 1)} type="button">Previous</button>
        <button disabled={result.page >= lastPage} onClick={() => setPage(result.page + 1)} type="button">Next</button>
      </div>
    </footer> : null}
  </section>;
}
