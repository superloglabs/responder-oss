import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchAgent, type AgentDetail } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { Button } from "../design-system";
import { AgentCreatePage } from "./agent-create";

export function AgentDetailPage() {
  const { agentId } = useParams();
  return <AgentDetailContent key={agentId} agentId={agentId} />;
}

function AgentDetailContent({ agentId }: { agentId?: string }) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!agentId) return;
    void fetchAgent(agentId).then((loaded) => {
      if (!cancelled) setAgent(loaded);
    }).catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "Unable to load agent");
    });
    return () => { cancelled = true; };
  }, [agentId]);

  // The editor starts with the original configuration and history. Optional
  // settings requests cannot block history or enable lossy legacy editing.
  if (agent && agent.id === agentId) return <AgentCreatePage key={agent.id} initialAgent={agent} />;
  return <AppShell redesigned active="agents" density="create"><section className="emptyState">
    <h1>{error ? "Unable to load agent" : "Loading agent…"}</h1>
    {error ? <><p>{error}</p><Button onClick={() => window.location.reload()} variant="secondary">Retry</Button><Link to="/agents">Back to agents</Link></> : null}
  </section></AppShell>;
}
