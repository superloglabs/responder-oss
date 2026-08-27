import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  type AgentDetail,
  type AgentOptions,
  fetchAgent,
  fetchAgentOptions,
  relativeTime,
  setAgentEnabled,
} from "../agents-api";
import {
  type AgentPipelineCard,
  buildAgentPipelinePresentation,
} from "../agent-detail-presentation";
import { AppShell } from "../components/app-shell";
import { AgentDetailSkeleton } from "../components/screen-skeletons";
import { dateGroupLabel } from "../date-presentation";
import {
  Badge,
  DataTable,
  Panel,
  Switch,
  type DataTableColumn,
} from "../design-system";
import { useDocumentTitle } from "../use-document-title";

const EMPTY_OPTIONS: AgentOptions = {
  accounts: [],
  repositories: [],
  resources: [],
  secrets: [],
};

function investigationStatus(
  status: AgentDetail["investigations"][number]["status"],
) {
  switch (status) {
    case "pending":
      return "Queued";
    case "investigating":
      return "Investigating";
    case "resolved":
      return "Resolved";
    case "failed":
      return "Failed";
  }
}

function investigationTone(
  status: AgentDetail["investigations"][number]["status"],
): "danger" | "info" | "live" | "warning" {
  switch (status) {
    case "pending":
      return "warning";
    case "investigating":
      return "info";
    case "resolved":
      return "live";
    case "failed":
      return "danger";
  }
}

interface AgentPipelineNodeData extends Record<string, unknown> {
  card: AgentPipelineCard;
  direction: "horizontal" | "vertical";
  role: "context" | "input" | "output";
}

type AgentPipelineNode = Node<AgentPipelineNodeData, "agentPipeline">;

function AgentPipelineNodeCard({ data }: NodeProps<AgentPipelineNode>) {
  const inputPosition =
    data.direction === "vertical" ? Position.Top : Position.Left;
  const outputPosition =
    data.direction === "vertical" ? Position.Bottom : Position.Right;
  const accessibleLabel = [
    data.card.eyebrow,
    data.card.title,
    data.card.detail,
    data.card.meta,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <Panel
      aria-label={accessibleLabel}
      className={`agentPipelineNode agentPipelineNode--${data.role}`}
      padding="compact"
      surface="raised"
    >
      {data.role !== "input" ? (
        <Handle
          className="agentPipelineHandle"
          position={inputPosition}
          type="target"
        />
      ) : null}
      <span className="agentPipelineNode__eyebrow">{data.card.eyebrow}</span>
      <strong>{data.card.title}</strong>
      {data.card.detail ? (
        <span className="agentPipelineNode__detail" title={data.card.detail}>
          {data.card.detail}
        </span>
      ) : null}
      {data.card.meta ? (
        <span className="agentPipelineNode__meta" title={data.card.meta}>
          {data.card.meta}
        </span>
      ) : null}
      {data.role !== "output" ? (
        <Handle
          className="agentPipelineHandle"
          position={outputPosition}
          type="source"
        />
      ) : null}
    </Panel>
  );
}

function AgentPipelineEdge({
  id,
  markerEnd,
  sourcePosition,
  sourceX,
  sourceY,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });

  return (
    <BaseEdge
      id={id}
      markerEnd={markerEnd}
      path={path}
      style={{ stroke: "var(--ds-border-strong)", strokeWidth: 1.25 }}
    />
  );
}

const agentPipelineNodeTypes = {
  agentPipeline: AgentPipelineNodeCard,
};

const agentPipelineEdgeTypes = {
  agentPipeline: AgentPipelineEdge,
};

function useVerticalPipeline() {
  const [vertical, setVertical] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 760px)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setVertical(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return vertical;
}

function AgentConfigurationFlow({
  agent,
  options,
}: {
  agent: AgentDetail & {
    configuration: NonNullable<AgentDetail["configuration"]>;
  };
  options: AgentOptions;
}) {
  const vertical = useVerticalPipeline();
  const direction = vertical ? "vertical" : "horizontal";
  const presentation = useMemo(
    () =>
      buildAgentPipelinePresentation(
        agent.configuration,
        agent.repositories,
        options,
      ),
    [agent.configuration, agent.repositories, options],
  );
  const nodes = useMemo<AgentPipelineNode[]>(
    () => [
      {
        data: { card: presentation.input, direction, role: "input" },
        height: 142,
        id: "input",
        position: { x: 0, y: 0 },
        type: "agentPipeline",
        width: vertical ? 320 : 300,
      },
      {
        data: { card: presentation.context, direction, role: "context" },
        height: 142,
        id: "context",
        position: vertical ? { x: 0, y: 196 } : { x: 444, y: 0 },
        type: "agentPipeline",
        width: vertical ? 320 : 400,
      },
      {
        data: { card: presentation.output, direction, role: "output" },
        height: 142,
        id: "output",
        position: vertical ? { x: 0, y: 392 } : { x: 988, y: 0 },
        type: "agentPipeline",
        width: vertical ? 320 : 300,
      },
    ],
    [direction, presentation, vertical],
  );
  const edges = useMemo<Edge[]>(
    () => [
      {
        id: "input-context",
        markerEnd: {
          color: "#4e4e4a",
          height: 14,
          type: MarkerType.ArrowClosed,
          width: 14,
        },
        source: "input",
        target: "context",
        type: "agentPipeline",
      },
      {
        id: "context-output",
        markerEnd: {
          color: "#4e4e4a",
          height: 14,
          type: MarkerType.ArrowClosed,
          width: 14,
        },
        source: "context",
        target: "output",
        type: "agentPipeline",
      },
    ],
    [],
  );

  return (
    <Panel className="agentConfiguration" padding="default" surface="base">
      <div className="agentConfiguration__header">
        <h2 id="agent-configuration-title">Agent configuration</h2>
      </div>
      <div
        className={`agentConfiguration__flow agentConfiguration__flow--${direction}`}
      >
        <ReactFlow
          aria-label="Agent configuration pipeline"
          edges={edges}
          edgeTypes={agentPipelineEdgeTypes}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: vertical ? 0.04 : 0 }}
          key={direction}
          maxZoom={1}
          minZoom={0.35}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          nodesFocusable={false}
          nodeTypes={agentPipelineNodeTypes}
          panOnDrag={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
          zoomOnDoubleClick={false}
          zoomOnPinch={false}
          zoomOnScroll={false}
        />
      </div>
    </Panel>
  );
}

export function AgentDetailPage() {
  const { agentId } = useParams();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [options, setOptions] = useState<AgentOptions>(EMPTY_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatingEnabled, setUpdatingEnabled] = useState(false);
  useDocumentTitle(agent?.name ?? "Agent");

  async function updateEnabled(enabled: boolean) {
    if (!agentId || !agent || updatingEnabled || enabled === agent.enabled) return;
    const previousAgent = agent;
    setError(null);
    setUpdatingEnabled(true);
    setAgent({ ...agent, enabled });
    try {
      await setAgentEnabled(agentId, enabled);
    } catch (caught: unknown) {
      setAgent(previousAgent);
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to update agent status",
      );
    } finally {
      setUpdatingEnabled(false);
    }
  }

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void Promise.all([
      fetchAgent(agentId),
      fetchAgentOptions().catch(() => EMPTY_OPTIONS),
    ])
      .then(([loadedAgent, loadedOptions]) => {
        if (!cancelled) {
          setAgent(loadedAgent);
          setOptions(loadedOptions);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        const message =
          caught instanceof Error ? caught.message : "Unable to load agent";
        if (message === "Agent not found") setNotFound(true);
        else setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (notFound || !agentId) return <Navigate replace to="/agents" />;
  if (loading) {
    return (
      <AppShell active="agents" density="compact">
        <AgentDetailSkeleton />
      </AppShell>
    );
  }
  if (!agent) {
    return (
      <AppShell active="agents" density="compact">
        <section className="emptyState">
          <h1>Unable to load agent</h1>
          <p>{error ?? "Try again in a moment."}</p>
          <Link className="button button--secondary" to="/agents">
            Back to agents
          </Link>
        </section>
      </AppShell>
    );
  }

  const investigationColumns: Array<
    DataTableColumn<AgentDetail["investigations"][number]>
  > = [
    {
      header: "Investigation",
      key: "investigation",
      render: (investigation) => (
        <Link
          className="agentInvestigation__main"
          to={`/agents/${agent.id}/investigations/${investigation.id}`}
        >
          <strong>
            {investigation.isReplay ? "Replay · " : ""}
            {investigation.title}
          </strong>
          <small>
            {investigation.finding?.summary ??
              (investigation.status === "failed"
                ? investigation.failureReason ?? "Investigation failed"
                : "Investigation in progress")} {" "}
            <span>
              · {investigation.input.provider}{" "}
              {investigation.input.externalEventId}
            </span>
          </small>
        </Link>
      ),
    },
    {
      header: "Status",
      key: "status",
      render: (investigation) => (
        <Badge tone={investigationTone(investigation.status)}>
          {investigationStatus(investigation.status)}
        </Badge>
      ),
      width: "120px",
    },
    {
      header: "Started",
      key: "started",
      render: (investigation) => (
        <time className="agentInvestigation__time">
          {relativeTime(investigation.createdAt)}
        </time>
      ),
      width: "100px",
    },
  ];

  return (
    <AppShell active="agents" density="compact">
      <section className="agentDetailHeading">
        <div>
          <h1>{agent.name}</h1>
          <p>{agent.description || "No description provided."}</p>
        </div>
        <div className="agentDetailActions">
          <Switch
            checked={agent.enabled}
            className="agentDetailStatusSwitch"
            disabled={updatingEnabled}
            label={
              updatingEnabled
                ? "Updating…"
                : agent.enabled
                  ? "Active"
                  : "Inactive"
            }
            onCheckedChange={(enabled) => void updateEnabled(enabled)}
          />
          <Link
            className="dsButton dsButton--primary dsButton--medium"
            to={`/agents/${agent.id}/edit`}
          >
            Edit agent
          </Link>
        </div>
      </section>

      {error ? <p className="formError">{error}</p> : null}

      {agent.configuration ? (
        <section aria-labelledby="agent-configuration-title">
          <AgentConfigurationFlow
            agent={{ ...agent, configuration: agent.configuration }}
            options={options}
          />
        </section>
      ) : (
        <Panel
          className="agentConfiguration agentConfiguration--empty"
          surface="base"
        >
          <h2>Agent configuration</h2>
          <p>This agent does not have an active configuration.</p>
        </Panel>
      )}

      <section aria-labelledby="investigation-title" className="agentInvestigations">
        <header>
          <h2 id="investigation-title">Investigations</h2>
          <span>{agent.investigations.length} total</span>
        </header>
        <DataTable
          aria-label="Agent investigations"
          columns={investigationColumns}
          emptyMessage="No investigations have run yet."
          getRowGroup={(investigation) =>
            dateGroupLabel(investigation.createdAt)
          }
          getRowKey={(investigation) => investigation.id}
          rows={agent.investigations}
        />
      </section>
    </AppShell>
  );
}
