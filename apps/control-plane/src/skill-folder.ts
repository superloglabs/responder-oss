import {
  parseSkillMarkdown,
  skillFilePathSchema,
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

// Adds files to a skill. A file with the same path replaces the old one.
export function mergeSkillFiles(current: SkillFile[], added: SkillFile[]): SkillFile[] {
  const byPath = new Map(current.map((file) => [file.path.toLowerCase(), file]));
  for (const file of added) byPath.set(file.path.toLowerCase(), file);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function formatFileSize(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
