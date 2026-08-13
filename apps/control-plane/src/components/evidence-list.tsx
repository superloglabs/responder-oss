import type { IssueEvidence } from "../agents-api";

export function EvidenceList({ evidence }: { evidence: IssueEvidence[] }) {
  if (evidence.length === 0) {
    return <p className="inlineEmpty">No evidence recorded.</p>;
  }
  return (
    <ul className="evidenceList">
      {evidence.map((item, index) => (
        <li className="shadow-xl" key={`${item.source}-${item.title}-${index}`}>
          <span>{item.source}</span>
          <div>
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
        </li>
      ))}
    </ul>
  );
}
