import { dir, file, type Dir, type Entry } from "@openai/agents/sandbox";
import { sandboxWorkspaceRoot } from "@responder/core/sandbox-config";
import type { SandboxSession } from "./sandbox-session.js";
import { parseSkillMarkdown } from "@responder/core/skills/config";
import { dirname, posix, relative } from "node:path";
import {
  downloadRepositoryFile,
  type CheckedOutRepository,
} from "./repositories.js";

// Codex and OpenCode read AGENTS.md and .agents/skills; Claude Code reads
// CLAUDE.md and .claude/skills. Every agent is told about all of them.
const instructionFileNames = ["AGENTS.md", "CLAUDE.md"] as const;
const skillRoots = [".agents/skills", ".claude/skills"] as const;
const maxInstructionFiles = 200;
const maxSkillsPerRoot = 100;
// A skill's name and description are in its front matter, near the top.
const skillHeaderBytes = 4_096;

export interface RepositoryInstructionFile {
  path: string;
  repository: string;
  // Whether the file is at the repository's root, so it applies to all of it.
  root: boolean;
}

export interface RepositorySkill {
  description?: string;
  // The skill's folder, after symlinks.
  directory: string;
  name: string;
  // The SKILL.md path as found, under one of the skill roots.
  path: string;
  repository: string;
}

export interface RepositoryAgentDocs {
  instructions: RepositoryInstructionFile[];
  skills: RepositorySkill[];
}

export interface RepositorySkillsDependencies {
  downloadFile: typeof downloadRepositoryFile;
}

const defaultDependencies: RepositorySkillsDependencies = {
  downloadFile: downloadRepositoryFile,
};

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function insideRepository(path: string, repositoryPath: string): boolean {
  return path.startsWith(`${repositoryPath}/`);
}

// Prints one tab-separated line per instruction file and per skill. Paths are
// resolved through symlinks so a CLAUDE.md that links to AGENTS.md, or a
// .claude/skills that links to .agents/skills, is listed once. Instruction
// files are listed shallowest first, so the limit keeps the root's.
function discoveryScript(repositories: CheckedOutRepository[]): string {
  const names = instructionFileNames.map((name) => `-name ${name}`).join(" -o ");
  return [
    "set -u",
    ...repositories.flatMap((repository, index) => [
      `repo=${shellQuote(repository.path)}`,
      `find "$repo" \\( -name .git -o -name node_modules \\) -prune -o \\( ${names} \\) -print 2>/dev/null | awk -F/ '{ print NF "\\t" $0 }' | LC_ALL=C sort -t "$(printf '\\t')" -k1,1n -k2 | cut -f2- | head -n ${maxInstructionFiles} | while IFS= read -r path; do`,
      `  resolved=$(realpath -e -- "$path" 2>/dev/null) || continue`,
      `  [ -f "$resolved" ] || continue`,
      `  printf 'instructions\\t${index}\\t%s\\t%s\\n' "$resolved" "$path"`,
      "done",
      ...skillRoots.flatMap((root) => [
        `count=0`,
        `for path in "$repo"/${root}/*/SKILL.md; do`,
        `  [ "$count" -lt ${maxSkillsPerRoot} ] || break`,
        `  resolved=$(realpath -e -- "$path" 2>/dev/null) || continue`,
        `  [ -f "$resolved" ] || continue`,
        `  count=$((count + 1))`,
        `  printf 'skill\\t${index}\\t%s\\t%s\\t%s\\n' "$resolved" "$path" "$(head -c ${skillHeaderBytes} -- "$resolved" | base64 -w0)"`,
        "done",
      ]),
    ]),
    "exit 0",
  ].join("\n");
}

// Finds the instruction files and skills in the checked-out repositories.
// Files that resolve outside their repository are skipped.
export async function discoverRepositoryAgentDocs(
  session: SandboxSession,
  repositories: CheckedOutRepository[],
): Promise<RepositoryAgentDocs> {
  if (repositories.length === 0) return { instructions: [], skills: [] };
  const output = await session.execCommand({
    cmd: discoveryScript(repositories),
    workdir: sandboxWorkspaceRoot,
    maxOutputTokens: 100_000,
  });
  if (!commandSucceeded(output)) return { instructions: [], skills: [] };
  const body = output.split("\nOutput:\n", 2)[1] ?? "";
  const instructions: RepositoryInstructionFile[] = [];
  const skills: RepositorySkill[] = [];
  const seen = new Set<string>();
  for (const line of body.split("\n")) {
    const [kind, index, resolved, path, header] = line.split("\t");
    const repository = repositories[Number(index)];
    if (!repository || !resolved || !path) continue;
    if (!insideRepository(resolved, repository.path) || !insideRepository(path, repository.path)) continue;
    if (seen.has(resolved)) continue;
    if (kind === "instructions") {
      seen.add(resolved);
      instructions.push({
        path,
        repository: repository.repository,
        root: posix.dirname(path) === repository.path,
      });
    } else if (kind === "skill" && header !== undefined) {
      seen.add(resolved);
      const { description } = parseSkillMarkdown(
        new TextDecoder().decode(Buffer.from(header, "base64")),
      );
      skills.push({
        ...(description ? { description: description.replace(/\s+/gu, " ").trim() } : {}),
        directory: posix.dirname(resolved),
        name: posix.basename(posix.dirname(path)),
        path,
        repository: repository.repository,
      });
    }
  }
  return { instructions, skills };
}

// Tells an automation agent which instruction files and skills its
// repositories hold. The agent reads them itself, whatever its harness.
export function repositoryAgentDocsInstructions(
  docs: RepositoryAgentDocs,
  workingRepository: string | undefined,
): string[] {
  const upfront = docs.instructions.filter(
    (instruction) => instruction.root && instruction.repository === workingRepository,
  );
  const scoped = docs.instructions.filter((instruction) => !upfront.includes(instruction));
  return [
    ...(upfront.length > 0
      ? [
          "Read these repository instructions before you start, and follow them:",
          ...upfront.map((instruction) => `- ${instruction.path}`),
        ]
      : []),
    ...(scoped.length > 0
      ? [
          "These repository instructions apply to the files in their folder. Read one before you work on files there, and follow it:",
          ...scoped.map((instruction) => `- ${instruction.repository}: ${instruction.path}`),
        ]
      : []),
    ...(docs.skills.length > 0
      ? [
          "Repository skills hold instructions for tasks in these repositories. Before a task a skill covers, read its SKILL.md; the skill's other files are in the same folder.",
          ...docs.skills.map((skill) =>
            `- ${skill.name} (${skill.repository}):${skill.description ? ` ${skill.description}` : ""} Read ${skill.path}.`,
          ),
        ]
      : []),
  ];
}

async function readSkillFile(
  session: SandboxSession,
  path: string,
  dependencies: RepositorySkillsDependencies,
): Promise<Uint8Array> {
  try {
    return await dependencies.downloadFile(session, path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read repository skill file ${path}: ${detail}`, {
      cause: error,
    });
  }
}

async function findFiles(
  session: SandboxSession,
  root: string,
): Promise<string[]> {
  const output = await session.execCommand({
    cmd: `find ${shellQuote(root)} -type f -print`,
    workdir: sandboxWorkspaceRoot,
    maxOutputTokens: 4_000,
  });
  if (!commandSucceeded(output)) return [];
  const body = output.split("\nOutput:\n", 2)[1] ?? "";
  return body.split("\n").map((path) => path.trim()).filter(Boolean);
}

async function readDirectoryEntry(
  session: SandboxSession,
  path: string,
  files: string[],
  dependencies: RepositorySkillsDependencies,
): Promise<Dir> {
  const children: Record<string, Entry> = {};
  const directFiles = new Map<string, string>();
  const directDirectories = new Set<string>();
  for (const childPath of files) {
    const childRelativePath = relative(path, childPath);
    const [name, ...nested] = childRelativePath.split("/");
    if (!name) continue;
    if (nested.length === 0) {
      directFiles.set(name, childPath);
    } else {
      directDirectories.add(name);
    }
  }
  for (const [name, childPath] of directFiles) {
    children[name] = file({
      content: await readSkillFile(session, childPath, dependencies),
    });
  }
  for (const name of directDirectories) {
    const nestedPath = `${path}/${name}`;
    const nestedFiles = files.filter((candidate) =>
      candidate.startsWith(`${nestedPath}/`),
    );
    children[name] = await readDirectoryEntry(
      session,
      nestedPath,
      nestedFiles,
      dependencies,
    );
  }
  return dir({ children });
}

// The skills capability's folder in the sandbox workspace, the SDK default.
export const repositorySkillsPath = ".agents";

// The skills capability adds its folder to the session's manifest, and a
// thread saves that manifest with the session. On the thread's next turn the
// capability refuses to add a folder that is already listed, so the resumed
// session drops it first and gets this turn's skills again. The earlier
// turn's files are removed too, so a skill deleted or renamed since then is
// gone. Repositories are checked out under `repositories/`, so the folder at
// the workspace root holds only the capability's copies. The agent controls
// the sandbox between turns, so the root must resolve to itself first.
export async function clearRepositorySkills(
  session: SandboxSession,
): Promise<void> {
  const root = sandboxWorkspaceRoot;
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      `[ "$(realpath -e -- '${root}')" = '${root}' ]`,
      `rm -rf -- '${root}/${repositorySkillsPath}'`,
    ].join("\n"),
    maxOutputTokens: 200,
    workdir: root,
  });
  if (!/(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output)) {
    throw new Error("Unable to clear the sandbox skills folder");
  }
  const entries = session.state.manifest.entries;
  for (const path of Object.keys(entries)) {
    if (
      path === repositorySkillsPath ||
      path.startsWith(`${repositorySkillsPath}/`)
    ) {
      delete entries[path];
    }
  }
}

// Copies the discovered skills for an investigation agent's skills capability.
export async function loadRepositorySkills(
  session: SandboxSession,
  repositorySkills: RepositorySkill[],
  dependencies: RepositorySkillsDependencies = defaultDependencies,
): Promise<Dir | undefined> {
  const skills: Record<string, Entry> = {};
  const usedNames = new Set<string>();

  for (const skill of repositorySkills) {
    const name = usedNames.has(skill.name)
      ? `${skill.repository.replace("/", "-")}-${skill.name}`
      : skill.name;
    if (usedNames.has(name)) continue;
    usedNames.add(name);
    skills[name] = await readDirectoryEntry(
      session,
      skill.directory,
      await findFiles(session, skill.directory),
      dependencies,
    );
  }

  return Object.keys(skills).length > 0 ? dir({ children: skills }) : undefined;
}

const pullRequestTemplateFiles = [
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
] as const;

export async function discoverPullRequestTemplates(
  session: SandboxSession,
  repositories: CheckedOutRepository[],
): Promise<string[]> {
  const templates: string[] = [];
  for (const repository of repositories) {
    for (const relativePath of pullRequestTemplateFiles) {
      const path = `${repository.path}/${relativePath}`;
      if (await session.pathExists(path)) {
        templates.push(`${repository.repository}: ${path}`);
      }
    }
    const templateDirectory = `${repository.path}/.github/PULL_REQUEST_TEMPLATE`;
    if (await session.pathExists(templateDirectory)) {
      for (const path of await findFiles(session, templateDirectory)) {
        if (dirname(path) === templateDirectory) {
          templates.push(`${repository.repository}: ${path}`);
        }
      }
    }
  }
  return templates;
}
