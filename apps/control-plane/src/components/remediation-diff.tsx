import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { IssueRemediation } from "../agents-api";
import { useColorTheme } from "../color-theme";
import { remediationFileGroups } from "./remediation-diff-files";

export function RemediationDiff({
  remediation,
}: {
  remediation: IssueRemediation & { type: "code_change" };
}) {
  const { theme } = useColorTheme();
  const fileGroups = useMemo(
    () => remediationFileGroups(remediation),
    [remediation],
  );

  if (fileGroups.length === 0) {
    return (
      <pre className="remediationDiff__fallback">
        {remediation.changes.map((change) =>
          `${change.repository ? `# ${change.repository}\n` : ""}${change.diff}`,
        ).join("\n\n")}
      </pre>
    );
  }

  return (
    <div className="remediationDiff">
      {fileGroups.map((group, groupIndex) => (
        <div
          className="remediationDiff__repository"
          key={`${remediation.id}-${group.repository ?? "unknown"}-${groupIndex}`}
        >
          {group.repository ? <h4>{group.repository}</h4> : null}
          <div className="remediationDiff__files">
            {group.files.map((file, fileIndex) => (
              <FileDiff
                className="remediationDiff__file"
                fileDiff={file}
                key={`${remediation.id}-${groupIndex}-${fileIndex}`}
                options={{
                  diffIndicators: "bars",
                  diffStyle: "unified",
                  overflow: "scroll",
                  themeType: theme,
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
