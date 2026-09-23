import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchAutomations,
  type AutomationListItem,
} from "../automations-api";
import { AppShell } from "../components/app-shell";
import { Badge } from "../design-system";
import { relativeTime } from "../agents-api";
import { useDocumentTitle } from "../use-document-title";

function triggerLabel(automation: AutomationListItem): string {
  if (automation.trigger.kind === "slack") return automation.trigger.eventMode === "mentions" ? "App mentioned" : automation.trigger.eventMode === "every_message" ? "Message posted" : "Message or mention";
  if (automation.trigger.kind === "sentry") return automation.trigger.eventTypes.includes("new_issue") ? "New issue" : "Regression";
  return "Slash command";
}

function statusLabel(status: AutomationListItem["lastRunStatus"]) {
  if (status === "succeeded") return "Completed";
  if (status === "pending") return "Queued";
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "—";
}

export function AutomationsPage() {
  const [automations, setAutomations] = useState<AutomationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle("Automations");

  useEffect(() => {
    let cancelled = false;
    void fetchAutomations()
      .then((items) => {
        if (!cancelled) setAutomations(items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load automations");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <AppShell active="automations">
      <div className="automationCanvas">
      <section className="automationPageHeader"><h1>Automations</h1><Link className="automationSave" to="/automations/new">＋ Create automation</Link></section>
      {error ? <p className="formError">{error}</p> : null}
      {loading ? <p className="automationLoading">Loading automations…</p> : null}
      {!loading && automations.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No automations yet</h2>
          <p>Add a model key, choose a trigger, and run a coding task in a fresh sandbox.</p>
          <Link className="dsButton dsButton--primary dsButton--medium" to="/automations/new">
            Create an automation
          </Link>
        </section>
      ) : null}
      {!loading && automations.length > 0 ? (
        <div className="automationTableWrap"><table className="automationTable"><thead><tr><th>Automation</th><th>Triggers</th><th>Connectors</th><th>Last run</th><th>Status</th></tr></thead><tbody>{automations.map((automation) => <tr key={automation.id}><td><Link className="automationTableName" to={`/automations/${automation.id}`}><strong>{automation.name}</strong><small>{automation.description || "No description provided."}</small></Link></td><td><span className="automationProviderIcon">{automation.trigger.kind[0].toUpperCase()}</span><span className="automationTableStack"><strong>{automation.trigger.kind[0].toUpperCase() + automation.trigger.kind.slice(1)}</strong><small>{triggerLabel(automation)}</small></span></td><td><span className="automationProviderIcon">G</span><span className="automationTableStack"><strong>GitHub</strong><small>{automation.harness === "claude_agent_sdk" ? "Claude Agent SDK" : automation.harness === "opencode" ? "OpenCode" : "Default"}</small></span></td><td>{automation.lastRunAt ? <span className="automationTableStack"><strong>{relativeTime(automation.lastRunAt)}</strong><small>{statusLabel(automation.lastRunStatus)}</small></span> : "—"}</td><td><Badge tone={automation.enabled ? "live" : "neutral"}>{automation.enabled ? "Active" : "Paused"}</Badge></td></tr>)}</tbody></table></div>
      ) : null}
      </div>
    </AppShell>
  );
}
