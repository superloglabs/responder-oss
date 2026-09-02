import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import type { RuntimeRepository } from "@responder/core/db/investigations";
import type { IssueRemediationSubmission } from "@responder/core/investigations/report";
import { describe, expect, it, vi } from "vitest";
import {
  applyProposedDiff,
  proposedPullRequestContent,
  selectProposedChange,
} from "./remediate.js";

const repositories: RuntimeRepository[] = [
  {
    defaultBranch: "main",
    fullName: "acme/api",
    installationId: 42,
    private: true,
  },
  {
    defaultBranch: "main",
    fullName: "acme/web",
    installationId: 42,
    private: true,
  },
];

function remediation(
  changes: Array<{
    diff: string;
    pullRequest?: { body: string; title: string };
    repository: string | null;
  }>,
): IssueRemediationSubmission {
  return {
    type: "code_change",
    title: "Handle the missing value",
    description: "Return early when the required value is missing.",
    changes,
  };
}

describe("proposed diff remediation", () => {
  it("selects only the assigned repository diff", () => {
    expect(
      selectProposedChange(
        remediation([
          { diff: "api diff", repository: "acme/api" },
          { diff: "web diff", repository: "acme/web" },
        ]),
        "acme/web",
        repositories,
      ),
    ).toEqual({ diff: "web diff", repository: repositories[1] });
  });

  it("selects the agent-authored pull request content with the diff", () => {
    const proposed = remediation([{
      diff: "api diff",
      repository: "acme/api",
      pullRequest: {
        title: "Handle missing route values",
        body: "Guard missing values before the route uses them.",
      },
    }]);

    expect(selectProposedChange(proposed, "acme/api", repositories)).toEqual({
      diff: "api diff",
      pullRequest: {
        title: "Handle missing route values",
        body: "Guard missing values before the route uses them.",
      },
      repository: repositories[0],
    });
  });

  it("publishes the agent-authored title and body without adding testing text", () => {
    const proposed = remediation([{
      diff: "api diff",
      repository: "acme/api",
      pullRequest: {
        title: "Handle missing route values",
        body: "Explain the fix in the format chosen during investigation.",
      },
    }]);
    if (proposed.type !== "code_change") throw new Error("Expected code change");
    const selected = selectProposedChange(proposed, "acme/api", repositories);

    expect(proposedPullRequestContent(proposed, selected)).toEqual({
      title: "Handle missing route values",
      body: "Explain the fix in the format chosen during investigation.",
    });
    expect(proposedPullRequestContent(proposed, selected).body).not.toContain(
      "Testing",
    );
  });

  it("uses the remediation title and description for older saved diffs", () => {
    const proposed = remediation([{ diff: "api diff", repository: "acme/api" }]);
    if (proposed.type !== "code_change") throw new Error("Expected code change");

    expect(
      proposedPullRequestContent(
        proposed,
        selectProposedChange(proposed, "acme/api", repositories),
      ),
    ).toEqual({
      title: "Handle the missing value",
      body: "Return early when the required value is missing.",
    });
  });

  it("supports a legacy repository-less diff for one attached repository", () => {
    expect(
      selectProposedChange(
        remediation([{ diff: "legacy diff", repository: null }]),
        undefined,
        [repositories[0]!],
      ),
    ).toEqual({ diff: "legacy diff", repository: repositories[0] });
  });

  it("rejects an ambiguous repository-less diff", () => {
    expect(() =>
      selectProposedChange(
        remediation([{ diff: "ambiguous diff", repository: null }]),
        undefined,
        repositories,
      ),
    ).toThrow("does not identify one attached repository");
  });

  it("applies the stored diff without running project checks", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Process exited with code 0\nOutput:\n",
      ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;
    const diff = [
      "diff --git a/src/route.ts b/src/route.ts",
      "--- a/src/route.ts",
      "+++ b/src/route.ts",
      "@@ -1 +1,2 @@",
      "+if (!value) return;",
      " use(value);",
    ].join("\n");

    await expect(
      applyProposedDiff(session, "/workspace/acme/api", diff),
    ).resolves.toBeUndefined();

    expect(session.materializeEntry).toHaveBeenCalledWith({
      entry: { type: "file", content: `${diff}\n` },
      path: "/home/daytona/workspace/.responder/proposed.patch",
    });
    expect(session.execCommand).toHaveBeenCalledWith({
      cmd: "git apply --whitespace=nowarn /home/daytona/workspace/.responder/proposed.patch",
      maxOutputTokens: 2_000,
      workdir: "/workspace/acme/api",
    });
    expect(JSON.stringify(vi.mocked(session.execCommand).mock.calls)).not.toMatch(
      /(?:pnpm|npm|yarn|bun|test|lint|typecheck)/,
    );
  });

  it("fails safely when the stored diff no longer applies", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Process exited with code 1\nOutput:\npatch failed with sensitive context",
      ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;

    await expect(
      applyProposedDiff(session, "/workspace/acme/api", "invalid diff"),
    ).rejects.toThrow("The proposed diff no longer applies cleanly");
  });

  it("rejects a proposed diff containing a workspace secret placeholder", async () => {
    const session = {
      execCommand: vi.fn(),
      materializeEntry: vi.fn(),
    } as unknown as DaytonaSandboxSession;

    await expect(
      applyProposedDiff(
        session,
        "/workspace/acme/api",
        "diff --git a/key.ts b/key.ts\n+dtn_secret_1234-abcd",
      ),
    ).rejects.toThrow("Proposed diff cannot contain a workspace secret placeholder");
    expect(session.materializeEntry).not.toHaveBeenCalled();
    expect(session.execCommand).not.toHaveBeenCalled();
  });
});
