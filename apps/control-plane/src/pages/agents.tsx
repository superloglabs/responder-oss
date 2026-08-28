import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type AgentListItem,
  fetchAgents,
  relativeTime,
  triggerLabel,
} from "../agents-api";
import {
  type AgentFilter,
  agentMatchesFilter,
  agentRunStatus,
  integrationsForAgent,
} from "../agent-list-presentation";
import { AppShell } from "../components/app-shell";
import { ArrowIcon, CogIcon, PlusIcon } from "../components/icons";
import { AgentListSkeleton } from "../components/screen-skeletons";
import { Badge, DataTable } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle("Agents");

  useEffect(() => {
    let cancelled = false;
    void fetchAgents()
      .then((loadedAgents) => {
        if (!cancelled) setAgents(loadedAgents);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Unable to load agents");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredAgents = agents.filter((agent) =>
    agentMatchesFilter(agent, agentFilter),
  );

  return (
    <AppShell active="agents">
      <section className="pageHeading pageHeading--agents">
        <div>
          <h1>Agents</h1>
          <p>Configure how Responder investigates and acts on incidents.</p>
        </div>
        <Link
          className="dsButton dsButton--primary dsButton--medium"
          to="/agents/new"
        >
          <PlusIcon />
          New agent
        </Link>
      </section>

      {error ? <p className="formError">{error}</p> : null}
      {loading ? (
        <AgentListSkeleton />
      ) : agents.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No agents yet</h2>
          <p>Connect your tools, then configure your first incident responder.</p>
          <Link
            className="dsButton dsButton--primary dsButton--medium"
            to="/agents/new"
          >
            Create an agent
          </Link>
        </section>
      ) : (
        <section
          aria-labelledby="agent-list-title"
          className="agentListTable"
        >
          <h2 className="srOnly" id="agent-list-title">
            Configured agents
          </h2>
          <DataTable<AgentListItem, AgentFilter>
            aria-label="Configured agents"
            activeFilter={agentFilter}
            columns={[
              {
                header: "Agent",
                key: "agent",
                render: (agent) => (
                  <Link
                    className="agentTableTitle"
                    to={`/agents/${agent.id}`}
                  >
                    <strong>{agent.name}</strong>
                    <small>{agent.description || "No description provided."}</small>
                  </Link>
                ),
                width: "34%",
              },
              {
                header: "Input",
                key: "input",
                render: (agent) => (
                  <span className="agentTableCell">
                    {triggerLabel(agent.trigger)}
                  </span>
                ),
                width: "18%",
              },
              {
                header: "Integrations",
                key: "integrations",
                render: (agent) => (
                  <span className="agentTableCell">
                    {integrationsForAgent(agent).join(" · ") || "—"}
                  </span>
                ),
                width: "19%",
              },
              {
                header: "Last run",
                key: "last-run",
                render: (agent) => (
                  <span className="agentTableRun">
                    {agent.latestRun ? (
                      <time dateTime={agent.latestRun.createdAt}>
                        {relativeTime(agent.latestRun.createdAt)}
                      </time>
                    ) : (
                      <span>Never</span>
                    )}
                    <small
                      className={
                        agent.latestRun?.status === "investigating"
                          ? "isLive"
                          : undefined
                      }
                    >
                      {agentRunStatus(agent)}
                    </small>
                  </span>
                ),
                width: "14%",
              },
              {
                header: "Status",
                key: "status",
                render: (agent) => (
                  <Badge tone={agent.enabled ? "live" : "neutral"}>
                    {agent.enabled ? "Active" : "Paused"}
                  </Badge>
                ),
                width: "10%",
              },
              {
                align: "right",
                header: "",
                key: "open",
                render: (agent) => (
                  <span className="agentTableActions">
                    <Link
                      aria-label={`Edit ${agent.name} settings`}
                      className="agentTableSettings"
                      to={`/agents/${agent.id}/edit`}
                    >
                      <CogIcon />
                    </Link>
                    <Link
                      aria-label={`Open ${agent.name}`}
                      className="agentTableArrow"
                      to={`/agents/${agent.id}`}
                    >
                      <ArrowIcon />
                    </Link>
                  </span>
                ),
                width: "8%",
              },
            ]}
            filters={[
              { count: agents.length, label: "All", value: "all" },
              {
                count: agents.filter((agent) => agent.enabled).length,
                dot: "var(--ds-positive)",
                label: "Active",
                value: "active",
              },
              {
                count: agents.filter((agent) => !agent.enabled).length,
                dot: "var(--ds-text-muted)",
                label: "Paused",
                value: "paused",
              },
            ]}
            getRowKey={(agent) => agent.id}
            onFilterChange={setAgentFilter}
            rows={filteredAgents}
          />
        </section>
      )}
    </AppShell>
  );
}
