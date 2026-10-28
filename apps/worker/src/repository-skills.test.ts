import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  discoverRepositoryAgentDocs,
  loadRepositorySkills,
  repositoryAgentDocsInstructions,
  type RepositorySkill,
} from "./repository-skills.js";

const repository = {
  branch: "main",
  path: "/home/daytona/workspace/repositories/example/repo",
  repository: "example/repo",
  sha: "a".repeat(40),
  workspaceBaseSha: "a".repeat(40),
};

function commandResponse(output: string, exitCode = 0): string {
  return `Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code ${exitCode}\nOutput:\n${output}`;
}

function base64(value: string): string {
  return Buffer.from(value).toString("base64");
}

const skill: RepositorySkill = {
  directory: `${repository.path}/.agents/skills/example`,
  name: "example",
  path: `${repository.path}/.agents/skills/example/SKILL.md`,
  repository: "example/repo",
};

function sessionForSkillFile(options?: { readError?: Error }) {
  const execCommand = vi.fn().mockResolvedValue(
    commandResponse(
      `${repository.path}/.agents/skills/example/SKILL.md\n${repository.path}/.agents/skills/example/references/guide.md`,
    ),
  );
  const downloadFile = options?.readError
    ? vi.fn().mockRejectedValue(options.readError)
    : vi.fn().mockResolvedValue(new TextEncoder().encode("skill instructions"));
  const session = { execCommand } as unknown as DaytonaSandboxSession;
  return { downloadFile, session };
}

describe("repository agent doc discovery", () => {
  it("lists instruction files and skills once each, with skill descriptions", async () => {
    const root = repository.path;
    const execCommand = vi.fn().mockResolvedValue(commandResponse([
      `instructions\t0\t${root}/AGENTS.md\t${root}/AGENTS.md`,
      // CLAUDE.md links to AGENTS.md.
      `instructions\t0\t${root}/AGENTS.md\t${root}/CLAUDE.md`,
      `instructions\t0\t${root}/packages/api/CLAUDE.md\t${root}/packages/api/CLAUDE.md`,
      `skill\t0\t${root}/.agents/skills/diagnosing-bugs/SKILL.md\t${root}/.agents/skills/diagnosing-bugs/SKILL.md\t${base64("---\nname: diagnosing-bugs\ndescription: >\n  Use when a bug\n  needs a cause.\n---\n# Diagnosing bugs\n")}`,
      // .claude/skills links to .agents/skills.
      `skill\t0\t${root}/.agents/skills/diagnosing-bugs/SKILL.md\t${root}/.claude/skills/diagnosing-bugs/SKILL.md\t${base64("---\n")}`,
      `skill\t0\t${root}/.claude/skills/release/SKILL.md\t${root}/.claude/skills/release/SKILL.md\t${base64("# Release\n")}`,
      // Links that leave the repository are skipped.
      `instructions\t0\t/etc/passwd\t${root}/docs/AGENTS.md`,
      `skill\t0\t/root/.ssh/SKILL.md\t${root}/.claude/skills/keys/SKILL.md\t${base64("---\n")}`,
      "",
    ].join("\n")));
    const session = { execCommand } as unknown as DaytonaSandboxSession;

    await expect(discoverRepositoryAgentDocs(session, [repository])).resolves.toEqual({
      instructions: [
        { path: `${root}/AGENTS.md`, repository: "example/repo", root: true },
        { path: `${root}/packages/api/CLAUDE.md`, repository: "example/repo", root: false },
      ],
      skills: [
        {
          description: "Use when a bug needs a cause.",
          directory: `${root}/.agents/skills/diagnosing-bugs`,
          name: "diagnosing-bugs",
          path: `${root}/.agents/skills/diagnosing-bugs/SKILL.md`,
          repository: "example/repo",
        },
        {
          directory: `${root}/.claude/skills/release`,
          name: "release",
          path: `${root}/.claude/skills/release/SKILL.md`,
          repository: "example/repo",
        },
      ],
    });
    const script = execCommand.mock.calls[0]![0].cmd as string;
    expect(script).toContain("-name AGENTS.md -o -name CLAUDE.md");
    expect(script).toContain('"$repo"/.agents/skills/*/SKILL.md');
    expect(script).toContain('"$repo"/.claude/skills/*/SKILL.md');
  });

  it("finds nothing when the command fails", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(commandResponse("", 1)),
    } as unknown as DaytonaSandboxSession;

    await expect(discoverRepositoryAgentDocs(session, [repository])).resolves.toEqual({
      instructions: [],
      skills: [],
    });
  });

  it("tells the agent to read the working repository's root instructions first", () => {
    const root = repository.path;
    const lines = repositoryAgentDocsInstructions({
      instructions: [
        { path: `${root}/AGENTS.md`, repository: "example/repo", root: true },
        { path: `${root}/CLAUDE.md`, repository: "example/repo", root: true },
        { path: `${root}/packages/api/AGENTS.md`, repository: "example/repo", root: false },
        { path: "/home/daytona/workspace/repositories/example/lib/AGENTS.md", repository: "example/lib", root: true },
      ],
      skills: [{ ...skill, description: "Explains the example." }],
    }, "example/repo");

    expect(lines).toEqual([
      "Read these repository instructions before you start, and follow them:",
      `- ${root}/AGENTS.md`,
      `- ${root}/CLAUDE.md`,
      "These repository instructions apply to the files in their folder. Read one before you work on files there, and follow it:",
      `- example/repo: ${root}/packages/api/AGENTS.md`,
      "- example/lib: /home/daytona/workspace/repositories/example/lib/AGENTS.md",
      "Repository skills hold instructions for tasks in these repositories. Before a task a skill covers, read its SKILL.md; the skill's other files are in the same folder.",
      `- example (example/repo): Explains the example. Read ${root}/.agents/skills/example/SKILL.md.`,
    ]);
  });

  it("adds nothing when the repositories have no instructions or skills", () => {
    expect(repositoryAgentDocsInstructions({ instructions: [], skills: [] }, "example/repo")).toEqual([]);
  });
});

describe("repository skill loading", () => {
  it("downloads every skill file without going through the editor", async () => {
    const { downloadFile, session } = sessionForSkillFile();

    await expect(
      loadRepositorySkills(session, [skill], { downloadFile }),
    ).resolves.toBeDefined();

    expect(downloadFile).toHaveBeenCalledTimes(2);
    expect(downloadFile).toHaveBeenNthCalledWith(
      1,
      session,
      `${repository.path}/.agents/skills/example/SKILL.md`,
    );
    expect(downloadFile).toHaveBeenNthCalledWith(
      2,
      session,
      `${repository.path}/.agents/skills/example/references/guide.md`,
    );
  });

  it("reports the original skill path when a bounded read fails", async () => {
    const readError = new Error("permission denied");
    const { downloadFile, session } = sessionForSkillFile({ readError });

    await expect(
      loadRepositorySkills(session, [skill], { downloadFile }),
    ).rejects.toThrow(
        `Unable to read repository skill file ${repository.path}/.agents/skills/example/SKILL.md: permission denied`,
      );
  });
});
