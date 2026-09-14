import { useMemo } from "react";
import {
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { parseRestrictedD2 } from "../codebase-knowledge-diagram";

export function CodebaseKnowledgeDiagram({ source }: { source: string }) {
  const parsed = useMemo(() => parseRestrictedD2(source), [source]);
  const nodes = useMemo<Node[]>(() => {
    const positions = new Map<number, number>();
    return parsed.nodes.map((node) => {
      const column = positions.get(node.level) ?? 0;
      positions.set(node.level, column + 1);
      return {
        id: node.id,
        data: { label: node.label },
        position: { x: column * 230, y: node.level * 145 },
        className: "knowledgeDiagram__node",
      };
    });
  }, [parsed.nodes]);
  const edges = useMemo<Edge[]>(
    () =>
      parsed.edges.map((edge) => ({
        ...edge,
        markerEnd: { type: MarkerType.ArrowClosed },
        type: "smoothstep",
      })),
    [parsed.edges],
  );

  return (
    <div className="knowledgeDiagram" role="group" aria-label="Codebase diagram">
      <ReactFlow
        key={source}
        edges={edges}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        maxZoom={1.2}
        minZoom={0.2}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodesFocusable={false}
        panOnDrag
        proOptions={{ hideAttribution: true }}
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
      />
    </div>
  );
}
