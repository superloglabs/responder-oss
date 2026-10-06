import type { PullRequestFile } from "./pull-requests-api";

// GitHub returns each file's hunks without the git headers. These headers
// tell the diff viewer the file's name, whether it was added, deleted, or
// renamed, and what it was called before. A path with a line break would
// split the headers, so that file is left for GitHub to show.
export function pullRequestFilePatch(file: PullRequestFile & { patch: string }): string | null {
  const previous = file.previousFilename ?? file.filename;
  if (/[\r\n]/u.test(previous) || /[\r\n]/u.test(file.filename)) return null;
  const header = [`diff --git a/${previous} b/${file.filename}`];
  if (file.status === "added") header.push("new file mode 100644");
  if (file.status === "removed") header.push("deleted file mode 100644");
  if (file.previousFilename && file.previousFilename !== file.filename) {
    header.push("similarity index 50%", `rename from ${previous}`, `rename to ${file.filename}`);
  }
  header.push(
    file.status === "added" ? "--- /dev/null" : `--- a/${previous}`,
    file.status === "removed" ? "+++ /dev/null" : `+++ b/${file.filename}`,
  );
  return `${header.join("\n")}\n${file.patch}`;
}

// The height a file's diff takes once rendered, so the page keeps its length
// while diffs render only near the viewport.
export function estimatedDiffHeight(file: PullRequestFile & { patch: string }): number {
  let lines = 1;
  for (let index = file.patch.indexOf("\n"); index !== -1; index = file.patch.indexOf("\n", index + 1)) lines += 1;
  return Math.min(4_000, 48 + lines * 20);
}

// Why a file has no diff to show.
export function missingPatchReason(file: PullRequestFile): string {
  if (file.status === "renamed" && file.additions === 0 && file.deletions === 0) {
    return `Renamed from ${file.previousFilename ?? "another path"} without changes.`;
  }
  if (file.additions === 0 && file.deletions === 0) return "Binary file or no line changes.";
  return "The diff is too large to show here.";
}

export function filesChangedLabel(files: PullRequestFile[]): string {
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  return `${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"} changed, +${additions.toLocaleString()} −${deletions.toLocaleString()}`;
}
