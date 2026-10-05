import {
  parseSkillMarkdown,
  skillFilePathSchema,
  skillFileRequestBytes,
  skillFilesMaxBytes,
  skillFilesMaxCount,
  skillInstructionsFileName,
  type SkillFile,
} from "../../../packages/core/src/skills/config";

export interface UploadedSkillFile {
  // Relative to the chosen folder or, for single files, the file name.
  path: string;
  bytes: Uint8Array;
}

export interface SkillFolder {
  // From the folder's SKILL.md, when it has one.
  skill?: ReturnType<typeof parseSkillMarkdown>;
  files: SkillFile[];
  // Paths left out, with the reason.
  skipped: Array<{ path: string; reason: string }>;
}

// A browser folder upload names each file from the folder itself, such as
// `billing-api/reference/openapi.yaml`. The skill keeps the path inside it.
export function folderRelativePath(webkitRelativePath: string): string {
  const [, ...rest] = webkitRelativePath.split("/");
  return rest.join("/");
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

// Turns uploaded files into skill files. Hidden files such as `.DS_Store` are
// skipped quietly; binary files and unsupported paths are reported.
export function readSkillFolder(uploaded: UploadedSkillFile[]): SkillFolder {
  const folder: SkillFolder = { files: [], skipped: [] };
  for (const file of uploaded) {
    if (file.path.split("/").some((segment) => segment.startsWith("."))) continue;
    const content = decodeText(file.bytes);
    if (content === null) {
      folder.skipped.push({ path: file.path, reason: "not a text file" });
      continue;
    }
    if (file.path.toLowerCase() === skillInstructionsFileName.toLowerCase()) {
      folder.skill = parseSkillMarkdown(content);
      continue;
    }
    if (!skillFilePathSchema.safeParse(file.path).success) {
      folder.skipped.push({ path: file.path, reason: "unsupported file name" });
      continue;
    }
    folder.files.push({ path: file.path, content });
  }
  folder.files.sort((left, right) => left.path.localeCompare(right.path));
  return folder;
}

// Adds files to a skill. A file with the same path replaces the old one. A
// file that would take the skill over its file count or size limit is left
// out and reported, so the skill can still be saved.
export function mergeSkillFiles(current: SkillFile[], added: SkillFile[]): {
  files: SkillFile[];
  skipped: Array<{ path: string; reason: string }>;
} {
  const byPath = new Map(current.map((file) => [file.path.toLowerCase(), file]));
  const skipped: Array<{ path: string; reason: string }> = [];
  const totalBytes = () => [...byPath.values()].reduce((total, file) => total + skillFileRequestBytes(file.content), 0);
  for (const file of added) {
    const key = file.path.toLowerCase();
    const replaced = byPath.get(key);
    if (!replaced && byPath.size >= skillFilesMaxCount) {
      skipped.push({ path: file.path, reason: `over the ${skillFilesMaxCount}-file limit` });
      continue;
    }
    const bytes = totalBytes() - (replaced ? skillFileRequestBytes(replaced.content) : 0) + skillFileRequestBytes(file.content);
    if (bytes > skillFilesMaxBytes) {
      skipped.push({ path: file.path, reason: "over the 3 MB limit" });
      continue;
    }
    byPath.set(key, file);
  }
  return {
    files: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    skipped,
  };
}

// Common credential formats. Skill text is stored and shown to the agent as
// is, so credentials belong in workspace secrets.
const credentialPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/u,
  /\b[rs]k_live_[A-Za-z0-9]{16,}/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bBearer [A-Za-z0-9._~+/-]{24,}/u,
];

// The names of the texts that look like they hold a credential.
export function likelyCredentialSources(texts: Array<{ name: string; content: string }>): string[] {
  return texts
    .filter((text) => credentialPatterns.some((pattern) => pattern.test(text.content)))
    .map((text) => text.name);
}

export function formatFileSize(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
