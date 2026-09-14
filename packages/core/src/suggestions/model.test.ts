import { describe, expect, it } from "vitest";
import { suggestionSubmissionSchema } from "./model.js";

const diff = [
  "diff --git a/src/worker.ts b/src/worker.ts",
  "--- a/src/worker.ts",
  "+++ b/src/worker.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

describe("suggestion submission", () => {
  it("accepts the exact Issue code-change shape", () => {
    expect(suggestionSubmissionSchema.parse({
      title: "Record queue wait time for investigations.",
      subtitle: "Current traces begin after a worker claims a job, hiding queue pressure.",
      detail: "## Why this helps\n\nQueue wait time separates capacity pressure from slow providers.",
      codeChange: {
        type: "code_change",
        title: "Instrument investigation queue wait time",
        description: "Records queue wait time when an investigation starts.",
        changes: [{
          repository: "acme/responder",
          diff,
          pullRequest: {
            title: "Instrument investigation queue wait time",
            body: "## Summary\n\nRecord queue wait time.",
          },
        }],
      },
    }).codeChange?.changes[0]?.diff).toBe(diff);
  });

  it("rejects repetitive multi-sentence copy and incomplete pull request content", () => {
    const result = suggestionSubmissionSchema.safeParse({
      title: "Record queue wait time. Alert on queue wait time.",
      subtitle: "Record queue wait time. Alert on queue wait time.",
      detail: "Details",
      codeChange: {
        type: "code_change",
        title: "Instrument queue wait",
        description: "Records queue wait time.",
        changes: [{ repository: null, diff }],
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining([
        "title",
        "subtitle",
        "codeChange.changes.0.pullRequest",
      ]),
    );
  });

  it("rejects ambiguous code changes that omit more than one repository", () => {
    const result = suggestionSubmissionSchema.safeParse({
      title: "Record queue wait time for investigations.",
      subtitle: "Current traces begin after a worker claims a job, hiding queue pressure.",
      detail: "## Why this helps\n\nQueue wait time separates capacity pressure from slow providers.",
      codeChange: {
        type: "code_change",
        title: "Instrument investigation queue wait time",
        description: "Records queue wait time when an investigation starts.",
        changes: [
          { repository: null, diff, pullRequest: { title: "First", body: "First" } },
          { repository: null, diff, pullRequest: { title: "Second", body: "Second" } },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "At most one code change may omit its repository",
        }),
      ]),
    );
  });
});
