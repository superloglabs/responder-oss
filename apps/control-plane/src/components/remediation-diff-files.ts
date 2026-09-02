import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { IssueRemediation } from "../agents-api";

type CodeChangeRemediation = IssueRemediation & { type: "code_change" };

export interface RemediationFileGroup {
  repository: string | null;
  files: FileDiffMetadata[];
}

export function remediationFileGroups(
  remediation: CodeChangeRemediation,
): RemediationFileGroup[] {
  const groups = new Map<string | null, RemediationFileGroup>();

  remediation.changes.forEach((change, changeIndex) => {
    try {
      const files = parsePatchFiles(
        change.diff,
        `remediation-${remediation.id}-${changeIndex}`,
        true,
      ).flatMap((patch) => patch.files);
      if (files.length === 0) return;

      const existing = groups.get(change.repository);
      if (existing) {
        existing.files.push(...files);
      } else {
        groups.set(change.repository, {
          repository: change.repository,
          files,
        });
      }
    } catch {
      // The raw unified diff is rendered by the caller when nothing can be parsed.
    }
  });

  return [...groups.values()];
}
