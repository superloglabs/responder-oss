import { processFile } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { estimatedDiffHeight, filesChangedLabel, missingPatchReason, pullRequestFilePatch } from "./pull-request-diff";

const patch = "@@ -1,3 +1,4 @@\n one\n-two\n+2\n+3\n four";
const file = { additions: 2, deletions: 1, filename: "src/a.ts", patch, previousFilename: null, status: "modified" as const };

function parse(input: Parameters<typeof pullRequestFilePatch>[0]) {
  const text = pullRequestFilePatch(input);
  return text === null ? undefined : processFile(text, { cacheKey: input.filename, isGitDiff: true });
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

  it("gives up on a path with a line break, which would split the headers", () => {
    expect(pullRequestFilePatch({ ...file, filename: "src/a\nb.ts" })).toBeNull();
    expect(pullRequestFilePatch({ ...file, filename: "src/b.ts", previousFilename: "src/a\r.ts", status: "renamed" })).toBeNull();
  });
});

describe("file summaries", () => {
  it("explains a missing diff", () => {
    expect(missingPatchReason({ ...file, additions: 0, deletions: 0, patch: null, previousFilename: "src/old.ts", status: "renamed" })).toBe("Renamed from src/old.ts without changes.");
    expect(missingPatchReason({ ...file, additions: 0, deletions: 0, patch: null })).toBe("Binary file or no line changes.");
    expect(missingPatchReason({ ...file, additions: 9000, patch: null })).toBe("The diff is too large to show here.");
  });

  it("reserves space for a diff before it renders", () => {
    expect(estimatedDiffHeight({ ...file, patch: "@@ -1 +1 @@\n-a\n+b" })).toBeGreaterThan(estimatedDiffHeight({ ...file, patch: "@@ -1 +1 @@" }));
    expect(estimatedDiffHeight({ ...file, patch: "x\n".repeat(100_000) })).toBeLessThanOrEqual(4_000);
  });

  it("totals the changes", () => {
    expect(filesChangedLabel([file, { ...file, additions: 10, deletions: 0 }])).toBe("2 files changed, +12 −1");
  });
});
