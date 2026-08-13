import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { createRepositoryInspectionTools } from "./repository-inspection.js";

const repository = {
  branch: "main",
  path: "/home/daytona/workspace/repositories/acme/service",
  repository: "acme/service",
  sha: "a".repeat(40),
  workspaceBaseSha: "b".repeat(40),
};

function sandboxOutput(output: string, exitCode = 0): string {
  return `Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code ${exitCode}\nOutput:\n${output}`;
}

describe("repository inspection tools", () => {
  it("does not expose repository tools when no repositories are attached", () => {
    const session = {
      execCommand: vi.fn(),
      readFile: vi.fn(),
    } as unknown as DaytonaSandboxSession;

    expect(
      createRepositoryInspectionTools({ repositories: [], session }),
    ).toEqual([]);
  });

  it("reads a bounded line range after checking the resolved path", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(sandboxOutput("2: two\n3: three")),
      readFile: vi.fn(),
    } as unknown as DaytonaSandboxSession;
    const tools = createRepositoryInspectionTools({
      repositories: [repository],
      session,
    });

    expect(tools.map(({ name }) => name)).toEqual([
      "list_repository_files",
      "search_repository",
      "read_repository_file",
    ]);
    await expect(
      tools[2]!.invoke(
        undefined as never,
        JSON.stringify({
          repository: "acme/service",
          path: "src/route.ts",
          startLine: 2,
          endLine: 3,
        }),
      ),
    ).resolves.toBe("2: two\n3: three");
    expect(session.execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringMatching(
          /\$root\/\.git.*-v start=2 -v end=3.*NR >= start && NR <= end/su,
        ),
        workdir: repository.path,
      }),
    );
    expect(session.readFile).not.toHaveBeenCalled();
  });

  it("rejects paths outside the attached repository", async () => {
    const session = {
      execCommand: vi.fn(),
      readFile: vi.fn(),
    } as unknown as DaytonaSandboxSession;
    const tools = createRepositoryInspectionTools({
      repositories: [repository],
      session,
    });

    await expect(
      tools[2]!.invoke(
        undefined as never,
        JSON.stringify({
          repository: "acme/service",
          path: "../.responder/repositories.json",
        }),
      ),
    ).resolves.toContain("Repository path must stay inside");
    expect(session.execCommand).not.toHaveBeenCalled();
  });

  it("includes hidden files while excluding Git metadata", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValue(sandboxOutput(".github/workflows/ci.yml")),
      readFile: vi.fn(),
    } as unknown as DaytonaSandboxSession;
    const tools = createRepositoryInspectionTools({
      repositories: [repository],
      session,
    });

    await tools[0]!.invoke(
      undefined as never,
      JSON.stringify({ repository: "acme/service" }),
    );

    expect(session.execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining("--hidden --glob '!.git/**'"),
      }),
    );
  });

  it("turns command failures into tool errors", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValue(sandboxOutput("permission denied", 111)),
      readFile: vi.fn(),
    } as unknown as DaytonaSandboxSession;
    const tools = createRepositoryInspectionTools({
      repositories: [repository],
      session,
    });

    await expect(
      tools[2]!.invoke(
        undefined as never,
        JSON.stringify({
          repository: "acme/service",
          path: "src/route.ts",
        }),
      ),
    ).resolves.toContain("permission denied");
  });

  it("returns an empty result when a repository search has no matches", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(sandboxOutput("", 1)),
      readFile: vi.fn(),
    } as unknown as DaytonaSandboxSession;
    const tools = createRepositoryInspectionTools({
      repositories: [repository],
      session,
    });

    await expect(
      tools[1]!.invoke(
        undefined as never,
        JSON.stringify({
          repository: "acme/service",
          query: "missing symbol",
        }),
      ),
    ).resolves.toBe("");
  });
});
