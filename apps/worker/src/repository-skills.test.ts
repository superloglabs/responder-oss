import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { loadRepositorySkills } from "./repository-skills.js";

const repository = {
  branch: "main",
  path: "/home/daytona/workspace/repositories/example/repo",
  repository: "example/repo",
  sha: "a".repeat(40),
  workspaceBaseSha: "a".repeat(40),
};

function commandResponse(output: string, exitCode = 0): string {
  return `Process exited with ${exitCode}\nOutput:\n${output}`;
}

function sessionForSkillFile(options?: { readError?: Error }) {
  const execCommand = vi.fn().mockResolvedValue(
    commandResponse(
      `${repository.path}/.agents/skills/example/SKILL.md\n${repository.path}/.agents/skills/example/references/guide.md`,
    ),
  );
  const downloadFile = options?.readError
    ? vi.fn().mockRejectedValue(options.readError)
    : vi.fn().mockResolvedValue(new TextEncoder().encode("skill instructions"));
  const session = {
    execCommand,
    pathExists: vi.fn((path: string) =>
      Promise.resolve(path.endsWith("/.agents/skills")),
    ),
  } as unknown as DaytonaSandboxSession;
  return { downloadFile, session };
}

describe("repository skill loading", () => {
  it("downloads every skill file without going through the editor", async () => {
    const { downloadFile, session } = sessionForSkillFile();

    await expect(
      loadRepositorySkills(session, [repository], { downloadFile }),
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
      loadRepositorySkills(session, [repository], { downloadFile }),
    ).rejects.toThrow(
        `Unable to read repository skill file ${repository.path}/.agents/skills/example/SKILL.md: permission denied`,
      );
  });
});
