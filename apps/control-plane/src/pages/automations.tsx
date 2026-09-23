import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchAutomations,
  type AutomationListItem,
} from "../automations-api";
import { AppShell } from "../components/app-shell";
import { PlusIcon } from "../components/icons";
import { Badge, DataTable } from "../design-system";
import { relativeTime } from "../agents-api";
import { useDocumentTitle } from "../use-document-title";

function triggerLabel(automation: AutomationListItem): string {
  if (automation.trigger.kind === "slack") return "Slack";
  if (automation.trigger.kind === "sentry") return "Sentry";
  return "Discord";
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
      <section className="pageHeading pageHeading--agents">
        <div>
          <h1>Automations</h1>
          <p>Run unattended coding tasks from operational events.</p>
        </div>
        <Link className="dsButton dsButton--primary dsButton--medium" to="/automations/new">
          <PlusIcon />
          New automation
        </Link>
      </section>
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
        <section className="agentListTable" aria-labelledby="automation-list-title">
          <h2 className="srOnly" id="automation-list-title">Configured automations</h2>
          <DataTable<AutomationListItem, "all">
            aria-label="Configured automations"
            activeFilter="all"
            columns={[
              {
                header: "Automation",
                key: "automation",
                render: (automation) => (
                  <Link className="agentTableTitle" to={`/automations/${automation.id}`}>
                    <strong>{automation.name}</strong>
                    <small>{automation.description || "No description provided."}</small>
                  </Link>
                ),
                width: "36%",
              },
              { header: "Trigger", key: "trigger", render: triggerLabel, width: "14%" },
              {
                header: "Runtime",
                key: "runtime",
                render: (automation) => (
                  <span className="agentTableCell">
                    {automation.harness.replaceAll("_", " ")} · {automation.model}
                  </span>
                ),
                width: "28%",
              },
              {
                header: "Status",
                key: "status",
                render: (automation) => (
                  <Badge tone={automation.enabled ? "live" : "neutral"}>
                    {automation.enabled ? "Enabled" : "Paused"}
                  </Badge>
                ),
                width: "12%",
              },
              {
                header: "Updated",
                key: "updated",
                render: (automation) => relativeTime(automation.updatedAt),
                width: "10%",
              },
            ]}
            filters={[{ count: automations.length, label: "All", value: "all" }]}
            getRowKey={(automation) => automation.id}
            onFilterChange={() => undefined}
            rows={automations}
          />
        </section>
      ) : null}
    </AppShell>
  );
}
