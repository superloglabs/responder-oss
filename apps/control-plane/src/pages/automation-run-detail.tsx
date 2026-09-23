import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { fetchAutomation, fetchAutomationRun, type AutomationDetail, type AutomationRunDetail } from "../automations-api";
import { AppShell } from "../components/app-shell";
import { Badge } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function eventDescription(event: AutomationRunDetail["events"][number]): string {
  switch (event.type) {
    case "run_started": return `Started with ${readable(event.data?.harness)} · ${readable(event.data?.model)}`;
    case "sandbox_ready": return "Fresh sandbox is ready";
    case "repositories_checked_out": return `Checked out ${readable(event.data?.count)} repositories`;
    case "action_succeeded": return readable(event.data?.kind) || "External action completed";
    case "run_succeeded": return "Run completed";
    case "run_failed": return "Run failed";
    case "run_cancelled": return "Run cancelled";
    default: return event.type.replaceAll("_", " ");
  }
}

export function AutomationRunDetailPage() {
  const { automationId, runId } = useParams();
  const [run, setRun] = useState<AutomationRunDetail | null>(null);
  const [automation, setAutomation] = useState<AutomationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle(run ? `Run · ${automation?.name ?? "Automation"}` : "Automation run");

  useEffect(() => {
    if (!runId || !automationId) return;
    let cancelled = false;
    const load = () => void Promise.all([fetchAutomationRun(runId), fetchAutomation(automationId)])
      .then(([loadedRun, loadedAutomation]) => {
        if (!cancelled) { setRun(loadedRun); setAutomation(loadedAutomation); setError(null); }
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load run"); });
    load();
    const timer = window.setInterval(() => { if (run?.status === "pending" || run?.status === "running") load(); }, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [automationId, runId, run?.status]);

  if (!automationId || !runId) return <Navigate replace to="/automations" />;
  if (error && !run) return <AppShell active="automations"><p className="formError">{error}</p></AppShell>;
  if (!run || !automation) return <AppShell active="automations"><p className="automationLoading">Loading run…</p></AppShell>;
  if (run.automationId !== automationId) return <Navigate replace to={`/automations/${automationId}`} />;

  const title = readable(run.redactedTrigger.title) || (run.status === "running" ? "Run in progress" : "Automation run");
  const sourceUrl = safeSourceUrl(run.redactedTrigger.sourceUrl);
  const source = readable(run.redactedTrigger.provider);
  const duration = run.startedAt && run.completedAt
    ? `${Math.max(1, Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))}s`
    : "—";

  return <AppShell active="automations"><div className="automationCanvas automationCanvas--run">
    <nav className="automationBreadcrumb"><Link to="/automations">Automations</Link><span>›</span><Link to={`/automations/${automationId}`}>{automation.name}</Link><span>›</span>Run</nav>
    <section className="automationPageHeader"><h1>{title}</h1><Badge tone={run.status === "succeeded" ? "live" : run.status === "failed" ? "danger" : run.status === "running" ? "warning" : "neutral"}>{run.status === "succeeded" ? "Completed" : run.status}</Badge></section>
    <div className="automationRunMeta"><span>{new Date(run.createdAt).toLocaleString()}</span><span>{duration}</span><span>{automation.configuration.model}</span><span>{automation.configuration.harness.replaceAll("_", " ")}</span><Link to={`/automations/${automationId}`}>View automation ↗</Link></div>
    <div className="automationTranscript"><article className="automationTranscriptTrigger"><div><span className="automationProviderIcon">{source[0]?.toUpperCase() ?? "M"}</span><strong>{source || "Manual"} trigger</strong><time>{new Date(run.createdAt).toLocaleTimeString()}</time>{sourceUrl ? <a href={sourceUrl} rel="noreferrer" target="_blank">↗</a> : null}</div><h2>{title}</h2>{Object.entries(run.redactedTrigger.attributes ?? {}).length ? <p>{Object.entries(run.redactedTrigger.attributes as Record<string, unknown>).map(([key, value]) => `${key}: ${readable(value)}`).join(" · ")}</p> : null}</article>
      {run.events.map((event) => <article className="automationTranscriptEvent" key={event.id}><span className="automationEventMark">✓</span><div><strong>{eventDescription(event)}</strong><time>{new Date(event.createdAt).toLocaleTimeString()}</time>{event.type === "repositories_checked_out" && Array.isArray(event.data?.repositories) ? <small>{event.data.repositories.map((item) => typeof item === "object" && item !== null && "repository" in item ? readable(item.repository) : "").filter(Boolean).join(" · ")}</small> : null}</div></article>)}
      {run.resultSummary || run.failureMessage ? <article className="automationTranscriptResult"><strong>{run.status === "failed" ? "Run failed" : "Result"}</strong><p>{run.failureMessage ?? run.resultSummary}</p></article> : null}
      {run.events.length === 0 ? <p className="automationFormHint">Waiting for the first run event…</p> : null}
    </div>
  </div></AppShell>;
}
