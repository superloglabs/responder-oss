import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { IssueRemediation } from "../agents-api";

export function RemediationDiff({
  remediation,
}: {
  remediation: IssueRemediation & { type: "code_change" };
}) {
  const files = useMemo(() => {
    try {
      return parsePatchFiles(
        remediation.diff,
        `remediation-${remediation.id}`,
        true,
      ).flatMap((patch) => patch.files);
    } catch {
      return [];
    }
  }, [remediation]);

  if (files.length === 0) {
    return <pre className="remediationDiff__fallback">{remediation.diff}</pre>;
  }

  return (
    <div className="remediationDiff">
      {files.map((file, index) => (
        <FileDiff
          className="remediationDiff__file"
          fileDiff={file}
          key={`${remediation.id}-${index}`}
          options={{
            diffIndicators: "bars",
            diffStyle: "unified",
            overflow: "scroll",
            themeType: "dark",
          }}
        />
      ))}
    </div>
  );
}
