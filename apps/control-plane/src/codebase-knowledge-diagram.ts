export interface ParsedD2Diagram {
  edges: Array<{ id: string; label?: string; source: string; target: string }>;
  nodes: Array<{ id: string; label: string; level: number }>;
}
export function parseRestrictedD2(source: string): ParsedD2Diagram {
  const labels = new Map<string, string>();
  const edges: ParsedD2Diagram["edges"] = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const edge = /^([a-z][a-z0-9_]*)\s*->\s*([a-z][a-z0-9_]*)(?:\s*:\s*(.+))?$/u.exec(line);
    if (edge) {
      edges.push({
        id: `edge-${edges.length}`,
        source: edge[1]!,
        target: edge[2]!,
        ...(edge[3]?.trim() ? { label: edge[3].trim() } : {}),
      });
      continue;
    }
    const node = /^([a-z][a-z0-9_]*)\s*:\s*(.+)$/u.exec(line);
    if (node) labels.set(node[1]!, node[2]!.trim());
  }

  const indegree = new Map([...labels.keys()].map((id) => [id, 0]));
  for (const edge of edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const levels = new Map([...labels.keys()].map((id) => [id, 0]));
  const queue = [...labels.keys()].filter((id) => indegree.get(id) === 0);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const source = queue.shift()!;
    visited.add(source);
    for (const edge of edges.filter((candidate) => candidate.source === source)) {
      levels.set(
        edge.target,
        Math.max(levels.get(edge.target) ?? 0, (levels.get(source) ?? 0) + 1),
      );
      const nextIndegree = (indegree.get(edge.target) ?? 1) - 1;
      indegree.set(edge.target, nextIndegree);
      if (nextIndegree === 0) queue.push(edge.target);
    }
  }
  const fallbackLevel = Math.max(0, ...levels.values());
  for (const id of labels.keys()) {
    if (!visited.has(id)) levels.set(id, fallbackLevel);
  }

  return {
    edges,
    nodes: [...labels].map(([id, label]) => ({
      id,
      label,
      level: levels.get(id) ?? 0,
    })),
  };
}
