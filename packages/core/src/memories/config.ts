import { z } from "zod";

// A workspace memory is one fact members saved for agents, such as how
// production is set up or what caused a past incident. It uses Claude Code's
// memory format: one Markdown file per memory, with a name, description, and
// type in its front matter, and a MEMORY.md index with one line per memory.
// Runs read memories and never change them.

export const memoryIndexFileName = "MEMORY.md";
export const memoryNameMaxLength = 100;
export const memoryDescriptionMaxLength = 1_024;
export const memoryBodyMaxLength = 20_000;
// Every memory is listed in each run's prompt, so a workspace keeps a few.
export const workspaceMemoriesMaxCount = 200;
// A full batch stays under the API's 1 MiB request limit.
export const memoryImportMaxCount = 20;

export const memoryTypes = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof memoryTypes)[number];

export const memoryNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(memoryNameMaxLength)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "Use lowercase letters, numbers, and single hyphens",
  );

export const memoryInputSchema = z.object({
  name: memoryNameSchema.describe("A short kebab-case name, such as `prod-database-failover`. Unique in the workspace."),
  description: z
    .string()
    .trim()
    .min(1, "Description is required")
    .max(memoryDescriptionMaxLength)
    .refine((description) => !description.includes("\n"), "Use one line")
    .describe("One line that says what the memory is about. Agents choose which memories to read from it."),
  type: z
    .enum(memoryTypes)
    .default("project")
    .describe("Claude Code's memory type: `project` for facts about the systems and ongoing work, `reference` for where to find something, `feedback` for how agents should work, and `user` for facts about the team."),
  body: z
    .string()
    .trim()
    .min(1, "Body is required")
    .max(memoryBodyMaxLength)
    .refine((body) => !body.includes("\u0000"), "Use text only")
    .describe("The memory in Markdown. Links to other memories use `[[name]]`."),
});

export type MemoryInput = z.output<typeof memoryInputSchema>;

// Values that look like credentials. A memory says where a secret is kept,
// never the secret itself.
const credentialPatterns: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { kind: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { kind: "a GitHub token", pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/u },
  { kind: "a Slack token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/u },
  { kind: "an API key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/u },
  { kind: "a Stripe key", pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/u },
  { kind: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { kind: "a JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u },
  { kind: "a URL with a password", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu },
  { kind: "a workspace secret placeholder", pattern: /dtn_secret_[a-z0-9_-]+/iu },
];

// The kinds of credentials a memory seems to contain.
export function memoryCredentialKinds(memory: Pick<MemoryInput, "body" | "description">): string[] {
  const text = `${memory.description}\n${memory.body}`;
  return credentialPatterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ kind }) => kind);
}

// A memory file as Claude Code writes it. JSON strings are valid YAML
// scalars, so the description cannot break the front matter.
export function renderMemoryMarkdown(memory: Pick<MemoryInput, "body" | "description" | "name" | "type">): string {
  return [
    "---",
    `name: ${JSON.stringify(memory.name)}`,
    `description: ${JSON.stringify(memory.description)}`,
    "metadata:",
    `  type: ${memory.type}`,
    "---",
    "",
    memory.body.trim(),
    "",
  ].join("\n");
}

export function memoryFileName(memory: { name: string }): string {
  return `${memory.name}.md`;
}

export function renderMemoryIndex(memories: ReadonlyArray<Pick<MemoryInput, "description" | "name">>): string {
  return `${memories.map((memory) => `- [${memory.name}](${memoryFileName(memory)}) — ${memory.description}`).join("\n")}\n`;
}
