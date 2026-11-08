import { tool } from "@openai/agents";
import type { SandboxSession } from "./sandbox-session.js";
import { z } from "zod";
import type { CheckedOutRepository } from "./repositories.js";

const LIST_FILES_PAGE_SIZE = 500;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function repositoryPath(
  repositories: CheckedOutRepository[],
  repositoryName: string,
  relativePath = ".",
): { repository: CheckedOutRepository; path: string } {
  const repository = repositories.find(
    (candidate) => candidate.repository === repositoryName,
  );
  if (!repository) {
    throw new Error("Repository is not attached to this Agent version");
  }

  const normalized = relativePath.trim() || ".";
  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === ".." || part === ".git")
  ) {
    throw new Error("Repository path must stay inside the selected repository");
  }
  return {
    repository,
    path:
      normalized === "." ? repository.path : `${repository.path}/${normalized}`,
  };
}

function checkedTargetScript(repositoryPath: string, targetPath: string): string {
  return [
    "set -eu",
    `root=$(realpath -e -- ${shellQuote(repositoryPath)})`,
    `target=$(realpath -e -- ${shellQuote(targetPath)})`,
    'case "$target" in "$root/.git"|"$root/.git/"*) echo "Repository path must stay inside the selected repository" >&2; exit 111 ;; "$root"|"$root"/*) ;; *) echo "Repository path must stay inside the selected repository" >&2; exit 111 ;; esac',
  ].join("\n");
}

async function runInspectionCommand(
  session: SandboxSession,
  input: { cmd: string; workdir: string },
  failureMessage: string,
  allowedExitCodes = [0],
): Promise<string> {
  const output = await session.execCommand({
    ...input,
    maxOutputTokens: 6_000,
  });
  const match = /(?:^|\n)Process exited with code (\d+)(?:\n|$)/u.exec(output);
  const detail = output.split("\nOutput:\n", 2)[1]?.trimEnd() ?? "";
  if (!match || !allowedExitCodes.includes(Number(match[1]))) {
    throw new Error(detail || failureMessage);
  }
  return detail;
}

export function createRepositoryInspectionTools(input: {
  repositories: CheckedOutRepository[];
  session: SandboxSession;
}) {
  if (input.repositories.length === 0) return [];

  const repositoryNames = input.repositories.map(({ repository }) => repository);
  const repositoryParameter = z
    .string()
    .trim()
    .min(1)
    .describe(`One of: ${repositoryNames.join(", ")}`);
  const relativePathParameter = z
    .string()
    .trim()
    .default(".")
    .describe("A path relative to the selected repository");

  const listRepositoryFiles = tool({
    name: "list_repository_files",
    description: `List files in an attached repository without changing the workspace. Returns at most ${LIST_FILES_PAGE_SIZE} files per call in path order; when the result is cut off it says so and gives the offset for the next call.`,
    parameters: z.object({
      repository: repositoryParameter,
      path: relativePathParameter,
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Number of files to skip, taken from a previous truncation notice"),
    }),
    async execute({ repository: repositoryName, path: relativePath, offset }) {
      const target = repositoryPath(
        input.repositories,
        repositoryName,
        relativePath,
      );
      // One line past the page tells us whether more files exist; sed quits
      // there so rg stops producing output.
      const lastLine = offset + LIST_FILES_PAGE_SIZE + 1;
      const output = await runInspectionCommand(
        input.session,
        {
          cmd: [
            checkedTargetScript(target.repository.path, target.path),
            [
              "rg --files --hidden --glob '!.git/**' --sort path -- \"$target\"",
              `sed -n '${offset + 1},${lastLine}p;${lastLine}q'`,
            ].join(" | "),
          ].join("\n"),
          workdir: target.repository.path,
        },
        "Unable to list repository files",
      );
      const files = output.split("\n");
      if (files.length <= LIST_FILES_PAGE_SIZE) return output;
      const nextOffset = offset + LIST_FILES_PAGE_SIZE;
      return `${files.slice(0, LIST_FILES_PAGE_SIZE).join("\n")}\n[truncated: showing files ${offset + 1}-${nextOffset}; call list_repository_files again with offset=${nextOffset} for more]`;
    },
  });

  const searchRepository = tool({
    name: "search_repository",
    description:
      "Search text in an attached repository without changing the workspace.",
    parameters: z.object({
      repository: repositoryParameter,
      path: relativePathParameter,
      query: z.string().min(1).max(1_000),
    }),
    async execute({ repository: repositoryName, path: relativePath, query }) {
      const target = repositoryPath(
        input.repositories,
        repositoryName,
        relativePath,
      );
      return runInspectionCommand(
        input.session,
        {
          cmd: [
            checkedTargetScript(target.repository.path, target.path),
            [
              "rg --line-number --no-heading --color never --max-count 200",
              "--hidden --glob '!.git/**' --",
              shellQuote(query),
              '"$target"',
            ].join(" "),
          ].join("\n"),
          workdir: target.repository.path,
        },
        "Unable to search repository files",
        [0, 1],
      );
    },
  });

  const readRepositoryFile = tool({
    name: "read_repository_file",
    description:
      "Read a bounded line range from a file in an attached repository without changing it.",
    parameters: z.object({
      repository: repositoryParameter,
      path: z.string().trim().min(1),
      startLine: z.number().int().min(1).default(1),
      endLine: z.number().int().min(1).optional(),
    }),
    async execute({ repository: repositoryName, path, startLine, endLine }) {
      const target = repositoryPath(input.repositories, repositoryName, path);
      const lastLine = endLine ?? startLine + 199;
      if (lastLine < startLine || lastLine - startLine >= 400) {
        throw new Error("Read at most 400 lines in ascending order");
      }
      return runInspectionCommand(
        input.session,
        {
          cmd: [
            checkedTargetScript(target.repository.path, target.path),
            '[ -f "$target" ] || { echo "Repository path is not a file" >&2; exit 112; }',
            `awk -v start=${startLine} -v end=${lastLine} 'NR >= start && NR <= end { print NR ": " $0 }' "$target"`,
          ].join("\n"),
          workdir: target.repository.path,
        },
        "Unable to read repository file",
      );
    },
  });

  return [listRepositoryFiles, searchRepository, readRepositoryFile];
}
