import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  cancelAutomationRun,
  fetchAutomation,
  runAutomation,
  setAutomationEnabled,
  type AutomationDetail,
  type AutomationRunSummary,
} from "../automations-api";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { Badge, DataTable } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

function runTone(run: AutomationRunSummary): "neutral" | "live" | "danger" | "warning" {
  if (run.status === "succeeded") return "live";
  if (run.status === "failed") return "danger";
  if (run.status === "running" || run.status === "pending") return "warning";
  return "neutral";
}

export function AutomationDetailPage() {
  const { automationId } = useParams();
  const [automation, setAutomation] = useState<AutomationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  useDocumentTitle(automation?.name ?? "Automation");

  const load = useCallback(async () => {
    if (!automationId) return;
    const generation = ++requestGeneration.current;
    try {
      const loadedAutomation = await fetchAutomation(automationId);
      if (requestGeneration.current === generation) {
        setAutomation(loadedAutomation);
        setMissing(false);
        setError(null);
      }
    } catch (cause) {
      if (requestGeneration.current !== generation) return;
      const message = cause instanceof Error ? cause.message : "Unable to load automation";
      if (message === "Automation not found") setMissing(true);
      else setError(message);
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, [automationId]);

  useEffect(() => {
    if (!automationId) return;
    const effectGeneration = ++requestGeneration.current;
    void Promise.resolve().then(() => {
      if (requestGeneration.current !== effectGeneration) return;
      setLoading(true);
      setAutomation(null);
      setMissing(false);
      setError(null);
      void load();
    });
    return () => {
      requestGeneration.current += 1;
    };
  }, [automationId, load]);
  useEffect(() => {
    if (!automation?.runs.some((run) => run.status === "pending" || run.status === "running")) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [automation?.runs, load]);

  async function startRun() {
    if (!automationId) return;
    setAction("run");
    setError(null);
    try {
      await runAutomation(automationId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start automation");
    } finally {
      setAction(null);
    }
  }

  async function toggleEnabled() {
    if (!automationId || !automation) return;
    setAction("toggle");
    try {
      await setAutomationEnabled(automationId, !automation.enabled);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update automation");
    } finally {
      setAction(null);
    }
  }

  async function cancelRun(runId: string) {
    setAction(runId);
    try {
      await cancelAutomationRun(runId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to cancel run");
    } finally {
      setAction(null);
    }
  }

  if (missing || !automationId) return <Navigate replace to="/automations" />;
  if (loading) return <AppShell active="automations"><p className="automationLoading">Loading automation…</p></AppShell>;
  if (!automation) return <AppShell active="automations"><p className="formError">{error ?? "This automation is unavailable."}</p></AppShell>;

  return (
    <AppShell active="automations">
      <section className="detailHeading automationDetailHeading">
        <div>
          <Link className="investigationBackLink" to="/automations">← Automations</Link>
          <div className="automationTitleLine"><h1>{automation.name}</h1><Badge tone={automation.enabled ? "live" : "neutral"}>{automation.enabled ? "Enabled" : "Paused"}</Badge></div>
          <p>{automation.description || "No description provided."}</p>
        </div>
        <div className="automationDetailActions">
          <button className="button button--secondary" disabled={action !== null} onClick={() => void toggleEnabled()} type="button">{automation.enabled ? "Pause" : "Enable"}</button>
          <Link className="button button--secondary" to={`/automations/${automation.id}/edit`}>Edit</Link>
          <button className="button button--primary" disabled={action !== null || !automation.enabled} onClick={() => void startRun()} type="button">{action === "run" ? "Starting…" : "Run now"}</button>
        </div>
      </section>
      {error ? <p className="formError">{error}</p> : null}
      <section className="automationOverviewGrid">
        <article><span>Trigger</span><strong>{automation.configuration.trigger.kind}</strong></article>
        <article><span>Harness</span><strong>{automation.configuration.harness.replaceAll("_", " ")}</strong></article>
        <article><span>Model</span><strong>{automation.configuration.model}</strong><small>{automation.configuration.modelProvider}</small></article>
        <article><span>Version</span><strong>v{automation.version}</strong></article>
      </section>
      <section className="automationRuns">
        <div className="automationSectionHeading"><div><h2>Runs</h2><p>Manual and triggered executions appear here.</p></div></div>
        {automation.runs.length === 0 ? <div className="emptyState"><h2>No runs yet</h2><p>Use Run now to test this automation with a manual event.</p></div> : (
          <DataTable<AutomationRunSummary>
            aria-label="Automation runs"
            columns={[
              { header: "Started", key: "started", render: (run) => <span><strong>{relativeTime(run.createdAt)}</strong><small className="automationRunDate">{new Date(run.createdAt).toLocaleString()}</small></span>, width: "24%" },
              { header: "Status", key: "status", render: (run) => <Badge tone={runTone(run)}>{run.status}</Badge>, width: "16%" },
              { header: "Result", key: "result", render: (run) => run.failureMessage ?? run.resultSummary ?? (run.status === "running" ? "Running in sandbox…" : "Waiting for a worker…"), width: "45%" },
              { align: "right", header: "", key: "actions", render: (run) => run.status === "pending" || run.status === "running" ? <button className="button button--secondary" disabled={action !== null} onClick={() => void cancelRun(run.id)} type="button">{action === run.id ? "Cancelling…" : "Cancel"}</button> : null, width: "15%" },
            ]}
            getRowKey={(run) => run.id}
            rows={automation.runs}
          />
        )}
      </section>
    </AppShell>
  );
}
