import type { PullRequestFile } from "./pull-requests-api";

// GitHub returns each file's hunks without the git headers. These headers
// tell the diff viewer the file's name, whether it was added, deleted, or
// renamed, and what it was called before.
export function pullRequestFilePatch(file: PullRequestFile & { patch: string }): string {
  const previous = file.previousFilename ?? file.filename;
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
