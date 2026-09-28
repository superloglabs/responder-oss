import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import type { RuntimeRepository } from "@responder/core/db/investigations";
import type { IssueRemediationSubmission } from "@responder/core/investigations/report";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("selects the repository base stored with the diff", () => {
    const proposed = remediation([{ diff: "api diff", repository: "acme/api" }]);
    if (proposed.type !== "code_change") throw new Error("Expected code change");
    proposed.changes[0]!.base = {
      branch: "main",
      sha: "a".repeat(40),
    };

    expect(selectProposedChange(proposed, "acme/api", repositories)).toEqual({
      base: { branch: "main", sha: "a".repeat(40) },
      diff: "api diff",
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
      cmd: [
        "git apply --whitespace=nowarn /home/daytona/workspace/.responder/proposed.patch",
        "git apply --whitespace=nowarn --recount /home/daytona/workspace/.responder/proposed.patch",
        "git apply --whitespace=nowarn --recount --unidiff-zero /home/daytona/workspace/.responder/proposed.patch",
        "git apply --whitespace=nowarn --recount --unidiff-zero -C3 /home/daytona/workspace/.responder/proposed.patch",
      ].join(" || "),
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

// Runs the sandbox command with real git in a temporary repository.
function applyInRepository(
  files: Record<string, string>,
  diff: string,
  createdPaths: string[] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), "proposed-diff-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    for (const [path, content] of Object.entries(files)) {
      writeFileSync(join(directory, path), content);
    }
    let patch = "";
    const session = {
      execCommand: vi.fn(async ({ cmd }: { cmd: string }) => {
        const patchPath = join(directory, "proposed.patch");
        writeFileSync(patchPath, patch);
        const result = spawnSync(
          "sh",
          ["-c", cmd.replaceAll("/home/daytona/workspace/.responder/proposed.patch", patchPath)],
          { cwd: directory, encoding: "utf8" },
        );
        return `Process exited with code ${result.status}\nOutput:\n${result.stderr}`;
      }),
      materializeEntry: vi.fn(async ({ entry }: { entry: { content: string } }) => {
        patch = entry.content;
      }),
    } as unknown as DaytonaSandboxSession;
    return applyProposedDiff(session, directory, diff).then(
      () =>
        Object.fromEntries(
          [...Object.keys(files), ...createdPaths].map((path) => [
            path,
            readFileSync(join(directory, path), "utf8"),
          ]),
        ),
    ).finally(() => rmSync(directory, { force: true, recursive: true }));
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

describe("proposed diff application with git", () => {
  const lines = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

  it("applies a diff whose hunk header miscounts its lines", async () => {
    const files = {
      "app.py": [...lines(4, "# line"), "value = 1", ...lines(3, "# tail")].join("\n") + "\n",
    };
    const diff = [
      "diff --git a/app.py b/app.py",
      "--- a/app.py",
      "+++ b/app.py",
      "@@ -5,4 +5,4 @@",
      "-value = 1",
      "+value = 2",
      " # tail 1",
      " # tail 2",
      " # tail 3",
      "diff --git a/test_app.py b/test_app.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test_app.py",
      "@@ -0,0 +1,5 @@",
      "+def test_value():",
      "+    assert True",
    ].join("\n");

    await expect(applyInRepository(files, diff, ["test_app.py"])).resolves.toEqual({
      "app.py": [...lines(4, "# line"), "value = 2", ...lines(3, "# tail")].join("\n") + "\n",
      "test_app.py": "def test_value():\n    assert True\n",
    });
  });

  it("applies hunks that end without trailing context", async () => {
    const files = {
      "judge.ts": [
        ...lines(34, "// line"),
        "import { z } from 'zod';",
        "import { callLLM } from '@/lib/ai';",
        "import { other } from 'x';",
        ...lines(41, "// middle"),
        "const MODEL = 'primary';",
        ...lines(10, "// tail"),
      ].join("\n") + "\n",
    };
    const diff = [
      "diff --git a/judge.ts b/judge.ts",
      "--- a/judge.ts",
      "+++ b/judge.ts",
      "@@ -35,6 +35,7 @@",
      " import { z } from 'zod';",
      " import { callLLM } from '@/lib/ai';",
      "+import { fallback } from '@/lib/ai/fallback';",
      "@@ -79 +80,2 @@",
      "-const MODEL = 'primary';",
      "+const MODELS = { primary: 'primary', fallback: 'fallback' };",
      "+export { MODELS };",
    ].join("\n");

    const applied = await applyInRepository(files, diff);
    expect(applied["judge.ts"]).toContain(
      "import { callLLM } from '@/lib/ai';\nimport { fallback } from '@/lib/ai/fallback';\nimport { other } from 'x';",
    );
    expect(applied["judge.ts"]).toContain(
      "// middle 41\nconst MODELS = { primary: 'primary', fallback: 'fallback' };\nexport { MODELS };\n// tail 1",
    );
  });

  it("drops invented context beyond three lines from a change", async () => {
    const source = [
      "export function prepScript(selector) {",
      "  return `(() => {",
      "    const sel = ${JSON.stringify(selector)};",
      "    if (!sel) return { found: false };",
      "    const el = document.querySelector(sel);",
      "    if (!el) return { found: false };",
      "    const r = el.getBoundingClientRect();",
      "    return { found: true, x: r.left };",
      "  })()`;",
      "}",
    ].join("\n") + "\n";
    const diff = [
      "diff --git a/route.ts b/route.ts",
      "--- a/route.ts",
      "+++ b/route.ts",
      "@@ -1,10 +1,15 @@",
      " export function prepScript(selector) {",
      "   return `(() => {",
      "     const sel = ${JSON.stringify(selector)};",
      "     if (!sel) return { found: false };",
      "-    const el = document.querySelector(sel);",
      "+    let el;",
      "+    try {",
      "+      el = document.querySelector(sel);",
      "+    } catch {",
      "+      return { found: false };",
      "+    }",
      "     if (!el) return { found: false };",
      "     const r = el.getBoundingClientRect();",
      "     return { found: true, x: r.left };",
      "     })()`;",
      " }",
    ].join("\n");

    const applied = await applyInRepository({ "route.ts": source }, diff);
    expect(applied["route.ts"]).toContain(
      "    let el;\n    try {\n      el = document.querySelector(sel);\n    } catch {",
    );
    expect(applied["route.ts"]).toContain("  })()`;\n}\n");
  });

  it("does not drop context next to a change", async () => {
    const files = { "app.py": "a = 1\nb = 2\nc = 3\nd = 4\n" };
    const diff = [
      "diff --git a/app.py b/app.py",
      "--- a/app.py",
      "+++ b/app.py",
      "@@ -1,4 +1,4 @@",
      " a = 1",
      " b = 9",
      "-c = 3",
      "+c = 30",
      " d = 4",
    ].join("\n");

    await expect(applyInRepository(files, diff)).rejects.toThrow(
      "The proposed diff no longer applies cleanly",
    );
  });

  it("still rejects a diff whose context does not match the code", async () => {
    const files = { "app.py": "value = 1\n" };
    const diff = [
      "diff --git a/app.py b/app.py",
      "--- a/app.py",
      "+++ b/app.py",
      "@@ -1 +1 @@",
      "-value = 3",
      "+value = 2",
    ].join("\n");

    await expect(applyInRepository(files, diff)).rejects.toThrow(
      "The proposed diff no longer applies cleanly",
    );
  });
});
