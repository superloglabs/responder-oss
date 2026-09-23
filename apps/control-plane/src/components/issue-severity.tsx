import type { IssueListItem } from "../agents-api";
import "./issue-severity.css";

export function IssueSeverity({ severity }: { severity: IssueListItem["severity"] }) {
  return (
    <span className={`issueSeverity issueSeverity--${severity.toLowerCase()}`}>
      <span className="issueSeverity__dot" aria-hidden="true" />
      <span>{severity}</span>
    </span>
  );
}
