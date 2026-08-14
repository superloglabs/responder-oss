import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  buildPullRequestBody,
  createPullRequestFromSandbox,
} from "./github-pull-request.js";

function commandResult(exitCode: number, output = "") {
  return `Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code ${exitCode}\nOutput:\n${output}`;
}

describe("GitHub pull requests from Daytona", () => {
  it("builds the same report body as the old agent", () => {
    expect(
      buildPullRequestBody({
        issue: "The route throws.",
        summary: "## Summary\nHandle the missing value.",
        testing: "## Testing\nUnit tests pass.",
      }),
    ).toBe(
      "## Summary\nHandle the missing value.\n\n## Issue\nThe route throws.\n\n## Testing\nUnit tests pass.",
    );
  });

  it("publishes changed sandbox files without putting the GitHub token in Daytona", async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(commandResult(0, "src/route.ts\0"))
      .mockResolvedValueOnce(commandResult(0, "present"))
      .mockResolvedValueOnce(commandResult(1));
    const session = {
      execCommand,
      readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("fixed\n")),
    } as unknown as DaytonaSandboxSession;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "commit-sha" }))
      .mockResolvedValueOnce(Response.json({ ref: "refs/heads/fix" }))
      .mockResolvedValueOnce(
        Response.json({ number: 42, html_url: "https://github.com/acme/app/pull/42" }),
      );

    await expect(
      createPullRequestFromSandbox(
        {
          baseBranch: "main",
          baseSha: "a".repeat(40),
          body: "Pull request body",
          installationId: 123,
          repository: "acme/app",
          repositoryPath: "/home/daytona/workspace/repositories/acme/app",
          requestId: "12345678-1234-1234-1234-123456789012",
          title: "Fix: Broken route",
          workspaceBaseSha: "b".repeat(40),
        },
        session,
        {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          fetch: fetchMock,
        },
      ),
    ).resolves.toEqual({
      branch: "fix/fix-broken-route-12345678",
      changedFiles: ["src/route.ts"],
      number: 42,
      url: "https://github.com/acme/app/pull/42",
    });
    expect(JSON.stringify(execCommand.mock.calls)).not.toContain("github-secret");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/git/blobs",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer github-secret" }),
      }),
    );
  });

  it("rejects a changed file containing a workspace secret placeholder", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(commandResult(0, "src/config.ts\0"))
        .mockResolvedValueOnce(commandResult(0, "present"))
        .mockResolvedValueOnce(commandResult(1)),
      readFile: vi
        .fn()
        .mockResolvedValue(
          new TextEncoder().encode('export const key = "dtn_secret_1234-abcd";'),
        ),
    } as unknown as DaytonaSandboxSession;
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      createPullRequestFromSandbox(
        {
          baseBranch: "main",
          baseSha: "a".repeat(40),
          body: "Pull request body",
          installationId: 123,
          repository: "acme/app",
          repositoryPath: "/home/daytona/workspace/repositories/acme/app",
          requestId: "12345678-1234-1234-1234-123456789012",
          title: "Fix: Broken route",
          workspaceBaseSha: "b".repeat(40),
        },
        session,
        {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          fetch: fetchMock,
        },
      ),
    ).rejects.toThrow("cannot contain a workspace secret placeholder");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
