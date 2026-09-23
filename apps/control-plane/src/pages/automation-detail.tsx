import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  cancelAutomationRun,
  fetchAutomation,
  fetchAutomationOptions,
  runAutomation,
  setAutomationEnabled,
  type AutomationDetail,
  type AutomationRunSummary,
  type AutomationOptions,
} from "../automations-api";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { Badge } from "../design-system";
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
  const [tab, setTab] = useState<"settings" | "runs">("settings");
  const [options, setOptions] = useState<AutomationOptions | null>(null);
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
    void fetchAutomationOptions().then(setOptions).catch(() => undefined);
  }, []);
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
      <div className="automationCanvas">
      <nav className="automationBreadcrumb"><Link to="/automations">Automations</Link><span>›</span>{automation.name}</nav>
      <section className="automationPageHeader"><h1>{automation.name}</h1><div className="automationHeaderActions"><button className="automationStatusButton" disabled={action !== null} onClick={() => void toggleEnabled()} type="button"><span className={automation.enabled ? "automationStatusDot" : "automationStatusDot isPaused"} />{automation.enabled ? "Active" : "Paused"}</button><button className="automationSave" disabled={action !== null || !automation.enabled} onClick={() => void startRun()} type="button">{action === "run" ? "Starting…" : "Run now"}</button></div></section>
      <nav aria-label="Automation sections" className="automationTabs"><button aria-current={tab === "settings" ? "page" : undefined} onClick={() => setTab("settings")} type="button">Settings</button><button aria-current={tab === "runs" ? "page" : undefined} onClick={() => setTab("runs")} type="button">Run history</button></nav>
      {error ? <p className="formError">{error}</p> : null}
      {tab === "settings" ? <div className="automationSettings"><section className="automationSection"><h2>Triggers</h2><div className="automationTriggerCard"><div className="automationTriggerHead"><span className="automationProviderIcon">{automation.configuration.trigger.kind[0].toUpperCase()}</span><strong>{automation.configuration.trigger.kind[0].toUpperCase() + automation.configuration.trigger.kind.slice(1)}</strong><span>{options?.accounts.find((account) => account.id === automation.configuration.trigger.integrationAccountId)?.displayName}</span></div><div className="automationSettingMeta"><span>Event</span><strong>{automation.configuration.trigger.kind === "slack" ? automation.configuration.trigger.eventMode.replaceAll("_", " ") : automation.configuration.trigger.kind === "sentry" ? automation.configuration.trigger.eventTypes.join(", ").replaceAll("_", " ") : "Slash command"}</strong></div><div className="automationSettingMeta"><span>{automation.configuration.trigger.kind === "sentry" ? "Projects" : "Channels"}</span><strong>{automation.configuration.trigger.kind === "sentry" ? automation.configuration.trigger.projectIds.join(", ") : automation.configuration.trigger.channelIds.join(", ")}</strong></div></div><p className="automationFormHint">Every matching event starts a run.</p></section><section className="automationSection"><h2>Agent instructions</h2><p className="automationPrompt">{automation.configuration.prompt}</p><div className="automationSettingMeta"><span>Model</span><strong>{automation.configuration.model}</strong><span>Harness</span><strong>{automation.configuration.harness.replaceAll("_", " ")}</strong></div></section><section className="automationSection"><h2>Repositories</h2>{automation.configuration.repositoryIds.map((id) => <div className="automationSelectedRow" key={id}><span className="automationProviderIcon">G</span><strong>{options?.repositories.find((repository) => repository.id === id)?.fullName ?? id}</strong></div>)}</section><section className="automationSection"><h2>Connectors</h2><div className="automationSelectedRow"><span className="automationProviderIcon">G</span><strong>GitHub</strong></div>{automation.configuration.contextAccountIds.map((id) => <div className="automationSelectedRow" key={id}><span className="automationProviderIcon">＋</span><strong>{options?.accounts.find((account) => account.id === id)?.displayName ?? id}</strong></div>)}</section><Link className="automationSave" to={`/automations/${automation.id}/edit`}>Edit settings</Link><p className="automationVersion">Version {automation.version} · Changes create a new version.</p></div> : null}
      {tab === "runs" ? <section className="automationRuns">
        {automation.runs.length === 0 ? <div className="emptyState"><h2>No runs yet</h2><p>Use Run now to test this automation with a manual event.</p></div> : (
          <div className="automationTableWrap"><table className="automationTable"><thead><tr><th>Run</th><th>Started</th><th>Duration</th><th>Result</th><th /></tr></thead><tbody>{automation.runs.map((run, index) => <tr key={run.id}><td><Link className="automationTableName" to={`/automations/${automation.id}/runs/${run.id}`}><strong>{run.failureMessage ?? run.resultSummary ?? (run.status === "running" ? "Run in progress" : "Automation run")}</strong><small>Run #{automation.runs.length - index} · {automation.configuration.trigger.kind}</small></Link></td><td>{relativeTime(run.createdAt)}</td><td>{run.startedAt && run.completedAt ? `${Math.max(1, Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))}s` : "—"}</td><td><Badge tone={runTone(run)}>{run.status === "succeeded" ? "Completed" : run.status}</Badge><small className="automationRunDate">{run.failureCategory ?? ""}</small></td><td>{run.status === "pending" || run.status === "running" ? <button className="automationTextButton" disabled={action !== null} onClick={() => void cancelRun(run.id)} type="button">{action === run.id ? "Cancelling…" : "Cancel"}</button> : <Link to={`/automations/${automation.id}/runs/${run.id}`}>›</Link>}</td></tr>)}</tbody></table></div>
        )}
      </section> : null}
      </div>
    </AppShell>
  );
}
