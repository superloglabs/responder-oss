import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { IssueRemediation } from "../agents-api";
import { useColorTheme } from "../color-theme";

export function RemediationDiff({
  remediation,
}: {
  remediation: IssueRemediation & { type: "code_change" };
}) {
  const { theme } = useColorTheme();
  const changes = useMemo(() => remediation.changes, [remediation.changes]);
  const files = useMemo(
    () => changes.flatMap((change, changeIndex) => {
      try {
        return parsePatchFiles(
          change.diff,
          `remediation-${remediation.id}-${changeIndex}`,
          true,
        ).flatMap((patch) =>
          patch.files.map((file) => ({ file, repository: change.repository })),
        );
      } catch {
        return [];
      }
    }),
    [changes, remediation.id],
  );

  if (files.length === 0) {
    return (
      <pre className="remediationDiff__fallback">
        {changes.map((change) =>
          `${change.repository ? `# ${change.repository}\n` : ""}${change.diff}`,
        ).join("\n\n")}
      </pre>
    );
  }

  return (
    <div className="remediationDiff">
      {files.map(({ file, repository }, index) => (
        <div key={`${remediation.id}-${index}`}>
          {repository ? <h4>{repository}</h4> : null}
          <FileDiff
            className="remediationDiff__file"
            fileDiff={file}
            options={{
              diffIndicators: "bars",
              diffStyle: "unified",
              overflow: "scroll",
              themeType: theme,
            }}
          />
        </div>
      ))}
    </div>
  );
}
