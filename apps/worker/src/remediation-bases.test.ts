import type { IssueRemediationSubmission } from "@responder/core/investigations/report";
import { describe, expect, it } from "vitest";
import { attachRepositoryBasesToRemediations } from "./remediation-bases.js";

const diff = [
  "diff --git a/src/route.ts b/src/route.ts",
  "--- a/src/route.ts",
  "+++ b/src/route.ts",
  "@@ -1 +1,2 @@",
  "+if (!value) return;",
  " use(value);",
].join("\n");

function codeRemediation(
  repository: string | null,
  base?: { branch: string; sha: string },
): IssueRemediationSubmission {
  return {
    type: "code_change",
    title: "Handle the missing value",
    description: "Return early when the required value is missing.",
    changes: [{ repository, diff, ...(base ? { base } : {}) }],
  };
}

describe("remediation repository bases", () => {
  it("records the trusted checkout for a repository diff", () => {
    expect(
      attachRepositoryBasesToRemediations(
        [
          codeRemediation("acme/api", {
            branch: "untrusted",
            sha: "f".repeat(40),
          }),
        ],
        [{ branch: "main", repository: "acme/api", sha: "a".repeat(40) }],
      ),
    ).toEqual([
      {
        ...codeRemediation("acme/api"),
        changes: [{
          repository: "acme/api",
          diff,
          base: { branch: "main", sha: "a".repeat(40) },
        }],
      },
    ]);
  });

  it("records the only checkout for a legacy repository-less diff", () => {
    const [remediation] = attachRepositoryBasesToRemediations(
      [codeRemediation(null)],
      [{ branch: "trunk", repository: "acme/api", sha: "b".repeat(40) }],
    );

    expect(remediation?.type === "code_change"
      ? remediation.changes[0]?.base
      : undefined).toEqual({ branch: "trunk", sha: "b".repeat(40) });
  });

  it("does not retain an untrusted base without a matching checkout", () => {
    const [remediation] = attachRepositoryBasesToRemediations(
      [
        codeRemediation("other/api", {
          branch: "untrusted",
          sha: "f".repeat(40),
        }),
      ],
      [{ branch: "main", repository: "acme/api", sha: "a".repeat(40) }],
    );

    expect(remediation?.type === "code_change"
      ? remediation.changes[0]?.base
      : undefined).toBeUndefined();
  });
});
