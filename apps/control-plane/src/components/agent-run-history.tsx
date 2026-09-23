import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { type AgentDetail, relativeTime } from "../agents-api";
import { dateGroupLabel } from "../date-presentation";
import { providerDisplayName } from "./provider-glyphs";

const labels = { pending: "Queued", investigating: "Running", resolved: "Completed", failed: "Failed" };

export function AgentRunHistory({ agent }: { agent: AgentDetail }) {
  return <section className="agentRunHistory" aria-label="Run history">
    <header><h2>Investigations</h2><span>{agent.investigations.length} recent</span><small>Latest activity</small></header>
    <div className="agentHistoryTable" role="table" aria-label="Agent investigations">
      <div className="agentHistoryRow agentHistoryRow--heading" role="row">
        <span role="columnheader">Investigation</span><span role="columnheader">Status</span><span role="columnheader">Started</span><span aria-hidden="true" />
      </div>
      {agent.investigations.length === 0 ? <div role="row"><p role="cell" aria-colspan={4} className="agentHistoryEmpty">No investigations have run yet.</p></div> : null}
      {agent.investigations.map((investigation, index) => {
        const group = dateGroupLabel(investigation.createdAt);
        const previous = agent.investigations[index - 1];
        return <div className="agentHistoryGroup" key={investigation.id} role="rowgroup">
          {!previous || dateGroupLabel(previous.createdAt) !== group ? <div className="agentHistoryDate" role="row"><span role="cell" aria-colspan={4}>{group}</span></div> : null}
          <div className="agentHistoryRow" role="row">
            <div role="cell"><Link to={`/agents/${agent.id}/investigations/${investigation.id}`}>
              <strong>{investigation.isReplay ? "Replay · " : ""}{investigation.title}</strong>
              <small>{investigation.finding?.summary ?? (investigation.status === "failed" ? investigation.failureReason ?? "Investigation failed" : investigation.status === "pending" ? "Waiting to start" : "Investigation in progress")} · {providerDisplayName(investigation.input.provider)} {investigation.input.externalEventId}</small>
            </Link></div>
            <div role="cell"><span className={`agentRunStatus agentRunStatus--${investigation.status}`}><i />{labels[investigation.status]}</span></div>
            <time role="cell" dateTime={investigation.createdAt} title={new Date(investigation.createdAt).toLocaleString()}>{relativeTime(investigation.createdAt)}</time>
            <div role="cell" className="agentHistoryAction"><Link to={`/agents/${agent.id}/investigations/${investigation.id}`} aria-label={`Open ${investigation.title}`}><ArrowUpRightIcon size={14} /></Link></div>
          </div>
        </div>;
      })}
    </div>
  </section>;
}
