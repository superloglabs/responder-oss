import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import { DotsThreeIcon as EllipsisIcon, PlusIcon, LightningIcon } from "@phosphor-icons/react";
import { AgentListSkeleton } from "../components/screen-skeletons";
import { Badge, DataTable, IconButton } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

function AgentRowMenu({ agent }: { agent: AgentListItem }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      className="agentRowMenu"
      ref={rootRef}
    >
      <IconButton
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions for ${agent.name}`}
        onClick={() => setOpen((value) => !value)}
        size="small"
        variant="ghost"
      >
        <EllipsisIcon />
      </IconButton>
      {open ? (
        <div className="agentRowMenu__popover" role="menu">
          <Link
            className="agentRowMenu__item"
            role="menuitem"
            to={`/agents/${agent.id}`}
          >
            View details
          </Link>
          <Link
            className="agentRowMenu__item"
            role="menuitem"
            to={`/agents/${agent.id}/edit`}
          >
            Edit agent
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
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
    <AppShell redesigned active="agents">
      <header className="workspaceHeading">
        <h1><LightningIcon size={16} weight="fill" aria-hidden="true" />Agents</h1>
        <div className="workspaceHeading__actions">
          <details className="issuesFilters">
            <summary>Filters{agentFilter !== "all" ? " · Active" : ""}</summary>
            <div className="issuesFilters__popover">
              <label>Status
                <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value as AgentFilter)}>
                  <option value="all">All agents</option>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                </select>
              </label>
            </div>
          </details>
          <Link className="dsButton dsButton--primary dsButton--small" to="/agents/new">
            <PlusIcon size={14} aria-hidden="true" />Create agent
          </Link>
        </div>
      </header>

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
          aria-label="Agents"
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
                width: "38%",
              },
              {
                header: "Input",
                key: "input",
                render: (agent) => (
                  <span className="agentTableCell">
                    {triggerLabel(agent.trigger)}
                  </span>
                ),
                width: "15%",
              },
              {
                header: "Integrations",
                key: "integrations",
                render: (agent) => (
                  <span className="agentTableCell">
                    {integrationsForAgent(agent).join(" · ") || "—"}
                  </span>
                ),
                width: "17%",
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
                width: "11%",
              },
              {
                align: "right",
                header: "",
                key: "actions",
                render: (agent) => <AgentRowMenu agent={agent} />,
                width: "5%",
              },
            ]}
            getRowKey={(agent) => agent.id}
            onFilterChange={setAgentFilter}
            onRowClick={(agent) => navigate(`/agents/${agent.id}`)}
            rows={filteredAgents}
          />
        </section>
      )}
    </AppShell>
  );
}
