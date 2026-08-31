import { dir, file, type Dir, type Entry } from "@openai/agents/sandbox";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { dirname, relative } from "node:path";
import type { CheckedOutRepository } from "./repositories.js";

const skillRoots = [".agents/skills", ".claude/skills"] as const;
const maxSkillFileBytes = 512_000;

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

async function findFiles(
  session: DaytonaSandboxSession,
  root: string,
): Promise<string[]> {
  const output = await session.execCommand({
    cmd: `find '${root.replace(/'/g, "'\\''")}' -type f -print`,
    workdir: "/home/daytona/workspace",
    maxOutputTokens: 4_000,
  });
  if (!commandSucceeded(output)) return [];
  const body = output.split("\nOutput:\n", 2)[1] ?? "";
  return body.split("\n").map((path) => path.trim()).filter(Boolean);
}

async function readDirectoryEntry(
  session: DaytonaSandboxSession,
  path: string,
  files: string[],
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
      content: await session.readFile({
        path: childPath,
        maxBytes: maxSkillFileBytes,
      }),
    });
  }
  for (const name of directDirectories) {
    const nestedPath = `${path}/${name}`;
    const nestedFiles = files.filter((candidate) =>
      candidate.startsWith(`${nestedPath}/`),
    );
    children[name] = await readDirectoryEntry(session, nestedPath, nestedFiles);
  }
  return dir({ children });
}

export async function loadRepositorySkills(
  session: DaytonaSandboxSession,
  repositories: CheckedOutRepository[],
): Promise<Dir | undefined> {
  const skills: Record<string, Entry> = {};
  const usedNames = new Set<string>();

  for (const repository of repositories) {
    for (const skillRoot of skillRoots) {
      const rootPath = `${repository.path}/${skillRoot}`;
      if (!(await session.pathExists(rootPath))) continue;
      const files = await findFiles(session, rootPath);
      const skillDirectories = new Set(
        files
          .filter((path) => path.endsWith("/SKILL.md"))
          .map((path) => dirname(path))
          .filter((path) => dirname(path) === rootPath),
      );
      for (const skillDirectory of skillDirectories) {
        const skillName = skillDirectory.slice(rootPath.length + 1);
        const name = usedNames.has(skillName)
          ? `${repository.repository.replace("/", "-")}-${skillName}`
          : skillName;
        usedNames.add(name);
        skills[name] = await readDirectoryEntry(
          session,
          skillDirectory,
          files.filter((path) => path.startsWith(`${skillDirectory}/`)),
        );
      }
    }
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
  session: DaytonaSandboxSession,
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

export async function discoverRepositoryInstructions(
  session: DaytonaSandboxSession,
  repositories: CheckedOutRepository[],
): Promise<string[]> {
  const instructions: string[] = [];
  for (const repository of repositories) {
    for (const path of await findFiles(session, repository.path)) {
      if (path.endsWith("/AGENTS.md") || path.endsWith("/CLAUDE.md")) {
        instructions.push(`${repository.repository}: ${path}`);
      }
    }
  }
  return instructions.sort();
}
