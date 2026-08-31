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
import { EllipsisIcon, PlusIcon } from "../components/icons";
import { AgentListSkeleton } from "../components/screen-skeletons";
import { Badge, DataTable, IconButton } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

function AgentRowMenu({ agent }: { agent: AgentListItem }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  function cancelScheduledClose() {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  // The short delay lets the pointer cross the gap between the trigger and
  // the popover without the menu closing underneath it.
  function scheduleClose() {
    cancelScheduledClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 140);
  }

  useEffect(() => cancelScheduledClose, []);

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
      onMouseEnter={cancelScheduledClose}
      onMouseLeave={scheduleClose}
      ref={rootRef}
    >
      <IconButton
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions for ${agent.name}`}
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => {
          cancelScheduledClose();
          setOpen(true);
        }}
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
                key: "actions",
                render: (agent) => <AgentRowMenu agent={agent} />,
                width: "5%",
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
            onRowClick={(agent) => navigate(`/agents/${agent.id}`)}
            rows={filteredAgents}
          />
        </section>
      )}
    </AppShell>
  );
}
