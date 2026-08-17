import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  checkoutRuntimeRepositories,
  repositoryWorkspacePath,
} from "./repositories.js";

const sha = "a".repeat(40);

function fakeSession() {
  return {
    execCommand: vi.fn().mockResolvedValue(
      `Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code 0\nOutput:\n${sha}`,
    ),
    materializeEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaytonaSandboxSession;
}

describe("Daytona repository checkout", () => {
  it("downloads selected repositories without placing the GitHub token in the sandbox", async () => {
    const session = fakeSession();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([31, 139, 8, 0]), { status: 200 }),
      );

    const checkedOut = await checkoutRuntimeRepositories(
      session,
      "version-id",
      {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        fetch: fetchMock,
        getRepositories: vi.fn().mockResolvedValue([
          {
            defaultBranch: "main",
            fullName: "example-org/example-repo",
            installationId: 123,
            private: true,
          },
        ]),
      },
    );

    expect(checkedOut).toEqual([
      {
        branch: "main",
        path: "/home/daytona/workspace/repositories/example-org/example-repo",
        repository: "example-org/example-repo",
        sha,
        workspaceBaseSha: sha,
      },
    ]);
    expect(session.materializeEntry).toHaveBeenCalledTimes(2);
    expect(session.execCommand).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(session.materializeEntry).mock.calls)).not.toContain(
      "github-secret",
    );
    expect(JSON.stringify(vi.mocked(session.execCommand).mock.calls)).not.toContain(
      "github-secret",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/example-org/example-repo/tarball/${sha}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer github-secret",
        }),
      }),
    );
  });

  it.each([429, 503])(
    "falls back to an exact Git fetch when the archive host returns %i",
    async (status) => {
      const session = fakeSession();
      const repository = {
        defaultBranch: "main",
        fullName: "example-org/example-repo",
        installationId: 123,
        private: true,
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ sha }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response("temporarily unavailable", { status }),
        );
      const downloadWithGit = vi.fn().mockResolvedValue({
        archive: new Uint8Array([31, 139, 8, 0]),
        sha,
      });

      await expect(
        checkoutRuntimeRepositories(session, "version-id", {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          downloadWithGit,
          fetch: fetchMock,
          getRepositories: vi.fn().mockResolvedValue([repository]),
        }),
      ).resolves.toEqual([
        expect.objectContaining({ repository: repository.fullName, sha }),
      ]);
      expect(downloadWithGit).toHaveBeenCalledWith(
        repository,
        "github-secret",
        sha,
      );
      expect(
        JSON.stringify(vi.mocked(session.materializeEntry).mock.calls),
      ).not.toContain("github-secret");
    },
  );

  it.each([429, 503])(
    "falls back to Git when branch resolution returns %i",
    async (status) => {
      const session = fakeSession();
      const repository = {
        defaultBranch: "main",
        fullName: "example-org/example-repo",
        installationId: 123,
        private: true,
      };
      const downloadWithGit = vi.fn().mockResolvedValue({
        archive: new Uint8Array([31, 139, 8, 0]),
        sha,
      });

      await expect(
        checkoutRuntimeRepositories(session, "version-id", {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          downloadWithGit,
          fetch: vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              new Response("temporarily unavailable", { status }),
            ),
          getRepositories: vi.fn().mockResolvedValue([repository]),
        }),
      ).resolves.toEqual([
        expect.objectContaining({ repository: repository.fullName, sha }),
      ]);
      expect(downloadWithGit).toHaveBeenCalledWith(
        repository,
        "github-secret",
        repository.defaultBranch,
      );
    },
  );

  it("falls back to Git when branch resolution times out", async () => {
    const session = fakeSession();
    const repository = {
      defaultBranch: "main",
      fullName: "example-org/example-repo",
      installationId: 123,
      private: true,
    };
    const downloadWithGit = vi.fn().mockResolvedValue({
      archive: new Uint8Array([31, 139, 8, 0]),
      sha,
    });

    await expect(
      checkoutRuntimeRepositories(session, "version-id", {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        downloadWithGit,
        fetch: vi
          .fn<typeof fetch>()
          .mockRejectedValue(new DOMException("Timed out", "AbortError")),
        getRepositories: vi.fn().mockResolvedValue([repository]),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ repository: repository.fullName, sha }),
    ]);
    expect(downloadWithGit).toHaveBeenCalledWith(
      repository,
      "github-secret",
      repository.defaultBranch,
    );
  });

  it("falls back to Git when the archive request times out", async () => {
    const session = fakeSession();
    const repository = {
      defaultBranch: "main",
      fullName: "example-org/example-repo",
      installationId: 123,
      private: true,
    };
    const downloadWithGit = vi.fn().mockResolvedValue({
      archive: new Uint8Array([31, 139, 8, 0]),
      sha,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )
      .mockRejectedValueOnce(new DOMException("Timed out", "AbortError"));

    await expect(
      checkoutRuntimeRepositories(session, "version-id", {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        downloadWithGit,
        fetch: fetchMock,
        getRepositories: vi.fn().mockResolvedValue([repository]),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ repository: repository.fullName, sha }),
    ]);
    expect(downloadWithGit).toHaveBeenCalledWith(
      repository,
      "github-secret",
      sha,
    );
  });

  it("rejects repository names that could escape the workspace", () => {
    expect(() => repositoryWorkspacePath("superlog/../../secret")).toThrow(
      "Invalid GitHub repository name",
    );
  });

  it("does not create sandbox files when no repository is selected", async () => {
    const session = fakeSession();
    await expect(
      checkoutRuntimeRepositories(session, "version-id", {
        createInstallationToken: vi.fn(),
        fetch: vi.fn(),
        getRepositories: vi.fn().mockResolvedValue([]),
      }),
    ).resolves.toEqual([]);
    expect(session.materializeEntry).not.toHaveBeenCalled();
    expect(session.execCommand).not.toHaveBeenCalled();
  });
});
