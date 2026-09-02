import { describe, expect, it } from "vitest";
import type { IssueRemediation } from "../agents-api";
import { remediationFileGroups } from "./remediation-diff-files";

const firstDiff = `diff --git a/src/first.ts b/src/first.ts
--- a/src/first.ts
+++ b/src/first.ts
@@ -1 +1 @@
-export const value = "old";
+export const value = "new";`;

const secondDiff = `diff --git a/src/second.ts b/src/second.ts
--- a/src/second.ts
+++ b/src/second.ts
@@ -1 +1 @@
-export const enabled = false;
+export const enabled = true;`;

function remediation(
  changes: Array<{ repository: string | null; diff: string }>,
): IssueRemediation & { type: "code_change" } {
  return {
    id: "remediation-1",
    type: "code_change",
    title: "Update the behavior",
    description: "Apply the required code changes.",
    changes,
  };
}

describe("remediation file groups", () => {
  it("groups every file in a repository diff under one repository entry", () => {
    const groups = remediationFileGroups(remediation([
      { repository: "acme/app", diff: `${firstDiff}\n${secondDiff}` },
    ]));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.repository).toBe("acme/app");
    expect(groups[0]?.files.map((file) => file.name)).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
  });

  it("keeps files from different repositories in separate entries", () => {
    const groups = remediationFileGroups(remediation([
      { repository: "acme/api", diff: firstDiff },
      { repository: "acme/web", diff: secondDiff },
    ]));

    expect(groups.map((group) => group.repository)).toEqual([
      "acme/api",
      "acme/web",
    ]);
  });
});
