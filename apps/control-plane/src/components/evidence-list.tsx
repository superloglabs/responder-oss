import type { IssueEvidence } from "../agents-api";
import {
  evidenceSourceGlyph,
  evidenceSourceLabel,
} from "../pages/issue-detail-presentation";
import { ProviderGlyph, SignalIcon } from "./icons";

export function EvidenceSourceGlyph({
  source,
}: {
  source: IssueEvidence["source"];
}) {
  const provider = evidenceSourceGlyph(source);
  return (
    <span className={`evidenceGlyph evidenceGlyph--${source}`}>
      {provider ? <ProviderGlyph decorative provider={provider} /> : <SignalIcon />}
    </span>
  );
}

export function EvidenceList({ evidence }: { evidence: IssueEvidence[] }) {
  if (evidence.length === 0) {
    return <p className="inlineEmpty">No evidence recorded.</p>;
  }
  return (
    <ul className="evidenceList">
      {evidence.map((item, index) => (
        <li key={`${item.source}-${item.title}-${index}`}>
          <EvidenceSourceGlyph source={item.source} />
          <div className="evidenceItem__body">
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
            {item.url ? (
              <a href={item.url} rel="noreferrer" target="_blank">
                Open evidence ↗
              </a>
            ) : item.file ? (
              <code>
                {item.file}
                {item.line ? `:${item.line}` : ""}
              </code>
            ) : null}
          </div>
          <span className="evidenceItem__source">
            {evidenceSourceLabel(item.source)}
          </span>
        </li>
      ))}
    </ul>
  );
}
