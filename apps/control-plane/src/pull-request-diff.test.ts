import { processFile } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { filesChangedLabel, missingPatchReason, pullRequestFilePatch } from "./pull-request-diff";

const patch = "@@ -1,3 +1,4 @@\n one\n-two\n+2\n+3\n four";
const file = { additions: 2, deletions: 1, filename: "src/a.ts", patch, previousFilename: null, status: "modified" as const };

function parse(input: Parameters<typeof pullRequestFilePatch>[0]) {
  return processFile(pullRequestFilePatch(input), { cacheKey: input.filename, isGitDiff: true });
}

describe("pullRequestFilePatch", () => {
  it("gives the diff viewer a modified file with its hunks", () => {
    expect(parse(file)).toMatchObject({ hunks: [expect.anything()], name: "src/a.ts", type: "change" });
  });

  it("marks added and deleted files", () => {
    expect(parse({ ...file, status: "added" })?.type).toBe("new");
    expect(parse({ ...file, status: "removed" })?.type).toBe("deleted");
  });

  it("keeps a renamed file's previous name", () => {
    expect(parse({ ...file, filename: "src/b.ts", previousFilename: "src/a.ts", status: "renamed" })).toMatchObject({
      name: "src/b.ts",
      prevName: "src/a.ts",
      type: "rename-changed",
    });
  });

  it("reads paths with spaces", () => {
    expect(parse({ ...file, filename: "docs/my notes.md" })?.name).toBe("docs/my notes.md");
  });
});

describe("file summaries", () => {
  it("explains a missing diff", () => {
    expect(missingPatchReason({ ...file, additions: 0, deletions: 0, patch: null, previousFilename: "src/old.ts", status: "renamed" })).toBe("Renamed from src/old.ts without changes.");
    expect(missingPatchReason({ ...file, additions: 0, deletions: 0, patch: null })).toBe("Binary file or no line changes.");
    expect(missingPatchReason({ ...file, additions: 9000, patch: null })).toBe("The diff is too large to show here.");
  });

  it("totals the changes", () => {
    expect(filesChangedLabel([file, { ...file, additions: 10, deletions: 0 }])).toBe("2 files changed, +12 −1");
  });
});
