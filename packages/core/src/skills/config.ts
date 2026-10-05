import { z } from "zod";

// A workspace skill is a folder the agent reads before a task: a SKILL.md with
// a name and description, and optional reference files such as an OpenAPI
// spec. It follows the Agent Skills format, so a skill folder written for
// Claude Code or Codex can be uploaded as is.

export const skillInstructionsFileName = "SKILL.md";
export const skillNameMaxLength = 64;
export const skillDescriptionMaxLength = 1_024;
export const skillInstructionsMaxLength = 100_000;
export const skillFilesMaxCount = 100;
export const skillFilePathMaxLength = 255;
// Requests to the skills API may be up to 4 MiB, so the files stay below it.
export const skillFilesMaxBytes = 3 * 1024 * 1024;
export const skillSecretsMaxCount = 20;

const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;
const pathSegmentPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const skillNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(skillNameMaxLength)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "Use lowercase letters, numbers, and single hyphens",
  );

// A relative path inside the skill folder. Segments cannot start with a dot,
// so a path cannot leave the folder or hide a file.
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(skillFilePathMaxLength)
  .refine(
    (path) => path.split("/").every((segment) => pathSegmentPattern.test(segment)),
    "Use a relative path of letters, numbers, dots, hyphens, and underscores",
  )
  .refine(
    (path) => path.toLowerCase() !== skillInstructionsFileName.toLowerCase(),
    "SKILL.md holds the instructions and cannot be added as a file",
  );

export const skillFileSchema = z.object({
  path: skillFilePathSchema,
  content: z
    .string()
    .refine((content) => !content.includes("\u0000"), "Only text files can be added"),
});

export const skillInputSchema = z
  .object({
    name: skillNameSchema,
    description: z
      .string()
      .trim()
      .min(1, "Description is required")
      .max(skillDescriptionMaxLength),
    instructions: z
      .string()
      .trim()
      .min(1, "Instructions are required")
      .max(skillInstructionsMaxLength),
    files: z.array(skillFileSchema).max(skillFilesMaxCount).default([]),
    secretIds: z
      .array(z.uuid())
      .max(skillSecretsMaxCount)
      .default([])
      .refine(uniqueIds, "Secret IDs must be unique"),
  })
  .superRefine((skill, context) => {
    const paths = skill.files.map((file) => file.path.toLowerCase());
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        message: "Each file needs a different path",
        path: ["files"],
      });
    }
    // A file path cannot also be the folder of another file.
    const folders = new Set(paths.flatMap((path) => {
      const segments = path.split("/");
      return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
    }));
    if (paths.some((path) => folders.has(path))) {
      context.addIssue({
        code: "custom",
        message: "A file path cannot also be a folder",
        path: ["files"],
      });
    }
    const bytes = skill.files.reduce((total, file) => total + utf8ByteLength(file.content), 0);
    if (bytes > skillFilesMaxBytes) {
      context.addIssue({
        code: "custom",
        message: "Files can total at most 3 MB",
        path: ["files"],
      });
    }
  });

export type SkillInput = z.output<typeof skillInputSchema>;
export type SkillFile = z.output<typeof skillFileSchema>;

// The SKILL.md written into the sandbox. JSON strings are valid YAML scalars,
// so the description cannot break the front matter.
export function renderSkillMarkdown(skill: {
  name: string;
  description: string;
  instructions: string;
}): string {
  return [
    "---",
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
    "",
    skill.instructions.trim(),
    "",
  ].join("\n");
}

function frontMatterScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

// Reads the name and description from a SKILL.md front matter and returns the
// rest as instructions. Only the top-level scalar keys a skill uses are read;
// block scalars (`|` and `>`) are joined into one line.
export function parseSkillMarkdown(markdown: string): {
  name?: string;
  description?: string;
  instructions: string;
} {
  const text = markdown.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(text);
  if (!match) return { instructions: text.trim() };
  const lines = match[1].split("\n");
  const values: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([A-Za-z_][\w-]*):(.*)$/u.exec(lines[index]);
    if (!field) continue;
    const [, key, rest] = field;
    if (/^\s*[|>][+-]?\s*$/u.test(rest)) {
      const block: string[] = [];
      while (index + 1 < lines.length && /^(\s+|$)/u.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index].trim());
      }
      values[key] = block.filter(Boolean).join(" ");
    } else {
      values[key] = frontMatterScalar(rest);
    }
  }
  return {
    ...(values.name ? { name: values.name } : {}),
    ...(values.description ? { description: values.description } : {}),
    instructions: text.slice(match[0].length).trim(),
  };
}
