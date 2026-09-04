import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  checkoutRuntimeRepository,
  checkoutRuntimeRepositories,
  checkoutRuntimeRepositoriesAtRefs,
  refreshRuntimeRepositories,
  resolveRuntimeRepositoryHeads,
  repositoryWorkspacePath,
} from "./repositories.js";

const sha = "a".repeat(40);
const execFileAsync = promisify(execFile);

function fakeSession() {
  return {
    execCommand: vi.fn().mockResolvedValue(
      `Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code 0\nOutput:\n${sha}`,
    ),
    materializeEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaytonaSandboxSession;
}

function uploadArchive() {
  return vi.fn().mockResolvedValue(undefined);
}

function missingGitmodules() {
  return new Response(null, { status: 404 });
}

describe("Daytona repository checkout", () => {
  it("resolves lightweight repository heads without downloading archives", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ sha }), { status: 200 }),
    );
    await expect(
      resolveRuntimeRepositoryHeads("version-id", {
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
      }),
    ).resolves.toEqual([
      {
        branch: "main",
        repository: "example-org/example-repo",
        sha,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/commits/main");
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("tarball");
  });

  it("retries transient repository head failures with bounded backoff", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha }), { status: 200 }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(resolveRuntimeRepositoryHeads("version-id", {
      createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
      fetch: fetchMock,
      getRepositories: vi.fn().mockResolvedValue([{
        defaultBranch: "main",
        fullName: "example-org/example-repo",
        installationId: 123,
        private: true,
      }]),
      wait,
    })).resolves.toEqual([expect.objectContaining({ sha })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it("downloads an exact pull request head without resolving the default branch", async () => {
    const session = fakeSession();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(missingGitmodules())
      .mockResolvedValueOnce(
        new Response(new Uint8Array([31, 139, 8, 0]), { status: 200 }),
      );

    await expect(
      checkoutRuntimeRepositoriesAtRefs(
        session,
        "version-id",
        new Map([
          ["example-org/example-repo", { branch: "fix/review", sha }],
        ]),
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
          uploadArchive: uploadArchive(),
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ branch: "fix/review", sha }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/example-org/example-repo/tarball/${sha}`,
      expect.anything(),
    );
  });

  it("downloads selected repositories without placing the GitHub token in the sandbox", async () => {
    const session = fakeSession();
    const upload = uploadArchive();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(missingGitmodules())
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
        uploadArchive: upload,
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
    expect(session.materializeEntry).toHaveBeenCalledTimes(1);
    expect(session.execCommand).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(session.materializeEntry).mock.calls)).not.toContain(
      "github-secret",
    );
    expect(JSON.stringify(vi.mocked(session.execCommand).mock.calls)).not.toContain(
      "github-secret",
    );
    expect(JSON.stringify(upload.mock.calls)).not.toContain("github-secret");
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/example-org/example-repo/tarball/${sha}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer github-secret",
        }),
      }),
    );
  });

  it("checks out only the repository assigned to a pull request", async () => {
    const session = fakeSession();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha }), { status: 200 }),
      )
      .mockResolvedValueOnce(missingGitmodules())
      .mockResolvedValueOnce(
        new Response(new Uint8Array([31, 139, 8, 0]), { status: 200 }),
      );

    await expect(
      checkoutRuntimeRepository(
        session,
        "version-id",
        "example-org/api",
        {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          fetch: fetchMock,
          getRepositories: vi.fn().mockResolvedValue([
            {
              defaultBranch: "main",
              fullName: "example-org/web",
              installationId: 123,
              private: true,
            },
            {
              defaultBranch: "main",
              fullName: "example-org/api",
              installationId: 123,
              private: true,
            },
          ]),
          uploadArchive: uploadArchive(),
        },
      ),
    ).resolves.toEqual(expect.objectContaining({ repository: "example-org/api" }));

    expect(JSON.stringify(fetchMock.mock.calls)).toContain("example-org/api");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("example-org/web");
  });

  it("uses an exact Git checkout when the parent commit declares submodules", async () => {
    const session = fakeSession();
    const downloadWithGit = vi.fn().mockResolvedValue({ sha });

    await expect(
      checkoutRuntimeRepositories(session, "version-id", {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        downloadWithGit,
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ sha }), { status: 200 }),
          )
          .mockResolvedValueOnce(new Response(null, { status: 200 })),
        getRepositories: vi.fn().mockResolvedValue([
          {
            defaultBranch: "main",
            fullName: "example-org/example-repo",
            installationId: 123,
            private: true,
          },
        ]),
        uploadArchive: uploadArchive(),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        repository: "example-org/example-repo",
        sha,
      }),
    ]);
    expect(downloadWithGit).toHaveBeenCalledWith(
      expect.objectContaining({ fullName: "example-org/example-repo" }),
      "github-secret",
      sha,
      expect.any(String),
      5 * 1024 * 1024 * 1024,
    );
  });

  it("archives recursively materialized submodule files without Git metadata", async () => {
    const session = fakeSession();
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "responder-submodule-checkout-test-"),
    );
    const binDirectory = join(temporaryDirectory, "bin");
    const gitPath = join(binDirectory, "git");
    const callsPath = join(temporaryDirectory, "git-calls");
    const authPath = join(temporaryDirectory, "git-auth");
    let uploadedEntries = "";
    await mkdir(binDirectory);
    await writeFile(
      gitPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$RESPONDER_TEST_GIT_CALLS\"",
        "case \" $* \" in",
        "  *\" fetch \"*) printf '%s\\n' \"$GIT_CONFIG_VALUE_0\" > \"$RESPONDER_TEST_GIT_AUTH\" ;;",
        "  *\" rev-parse \"*) printf '%s\\n' \"$RESPONDER_TEST_GIT_SHA\" ;;",
        "  *\" ls-tree \"*) printf '.gitmodules\\n' ;;",
        "  *\" worktree add \"*)",
        "    for argument do destination=\"${previous:-}\"; previous=\"$argument\"; done",
        "    mkdir -p \"$destination/.git\" \"$destination/open-core\"",
        "    printf 'pinned source\\n' > \"$destination/open-core/app.ts\"",
        "    ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${binDirectory}:${process.env.PATH ?? ""}`);
    vi.stubEnv("RESPONDER_TEST_GIT_AUTH", authPath);
    vi.stubEnv("RESPONDER_TEST_GIT_CALLS", callsPath);
    vi.stubEnv("RESPONDER_TEST_GIT_SHA", sha);

    try {
      await checkoutRuntimeRepositories(session, "version-id", {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
        getRepositories: vi.fn().mockResolvedValue([
          {
            defaultBranch: "main",
            fullName: "example-org/example-repo",
            installationId: 123,
            private: true,
          },
        ]),
        temporaryDirectory,
        uploadArchive: vi.fn(async (_session, localPath) => {
          const { stdout } = await execFileAsync("tar", ["-tzf", localPath]);
          uploadedEntries = stdout;
        }),
      });

      expect(uploadedEntries).toContain("./open-core/app.ts");
      expect(uploadedEntries).not.toMatch(/(?:^|\/)\.git(?:\/|$)/m);
      const gitCalls = await readFile(callsPath, "utf8");
      expect(gitCalls).toContain(
        "submodule update --init --recursive --depth=1",
      );
      expect(await readFile(authPath, "utf8")).toBe(
        `Authorization: Basic ${Buffer.from(
          "x-access-token:github-secret",
        ).toString("base64")}\n`,
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
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
        .mockResolvedValueOnce(missingGitmodules())
        .mockResolvedValueOnce(
          new Response("temporarily unavailable", { status }),
        );
      const downloadWithGit = vi.fn().mockResolvedValue({
        sha,
      });

      await expect(
        checkoutRuntimeRepositories(session, "version-id", {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          downloadWithGit,
          fetch: fetchMock,
          getRepositories: vi.fn().mockResolvedValue([repository]),
          uploadArchive: uploadArchive(),
        }),
      ).resolves.toEqual([
        expect.objectContaining({ repository: repository.fullName, sha }),
      ]);
      expect(downloadWithGit).toHaveBeenCalledWith(
        repository,
        "github-secret",
        sha,
        expect.any(String),
        5 * 1024 * 1024 * 1024,
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
          uploadArchive: uploadArchive(),
        }),
      ).resolves.toEqual([
        expect.objectContaining({ repository: repository.fullName, sha }),
      ]);
      expect(downloadWithGit).toHaveBeenCalledWith(
        repository,
        "github-secret",
        repository.defaultBranch,
        expect.any(String),
        5 * 1024 * 1024 * 1024,
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
        uploadArchive: uploadArchive(),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ repository: repository.fullName, sha }),
    ]);
    expect(downloadWithGit).toHaveBeenCalledWith(
      repository,
      "github-secret",
      repository.defaultBranch,
      expect.any(String),
      5 * 1024 * 1024 * 1024,
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
      .mockResolvedValueOnce(missingGitmodules())
      .mockRejectedValueOnce(new DOMException("Timed out", "AbortError"));

    await expect(
      checkoutRuntimeRepositories(session, "version-id", {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        downloadWithGit,
        fetch: fetchMock,
        getRepositories: vi.fn().mockResolvedValue([repository]),
        uploadArchive: uploadArchive(),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ repository: repository.fullName, sha }),
    ]);
    expect(downloadWithGit).toHaveBeenCalledWith(
      repository,
      "github-secret",
      sha,
      expect.any(String),
      5 * 1024 * 1024 * 1024,
    );
  });

  it("accepts repository archives declared larger than the previous 100 MB limit", async () => {
    const session = fakeSession();
    let uploadedArchive: Buffer | undefined;
    const upload = vi.fn(
      async (_session: DaytonaSandboxSession, localPath: string) => {
        uploadedArchive = await readFile(localPath);
      },
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha }), { status: 200 }),
      )
      .mockResolvedValueOnce(missingGitmodules())
      .mockResolvedValueOnce(
        new Response(new Uint8Array([31, 139, 8, 0]), {
          headers: { "content-length": String(101 * 1024 * 1024) },
          status: 200,
        }),
      );

    await expect(
      checkoutRuntimeRepositories(session, "version-id", {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        fetch: fetchMock,
        getRepositories: vi.fn().mockResolvedValue([
          {
            defaultBranch: "main",
            fullName: "example-org/large-repo",
            installationId: 123,
            private: true,
          },
        ]),
        uploadArchive: upload,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ repository: "example-org/large-repo", sha }),
    ]);
    expect(upload).toHaveBeenCalledWith(
      session,
      expect.stringMatching(/repository\.tar\.gz$/),
      expect.stringContaining("example-org-large-repo"),
    );
    expect(uploadedArchive).toEqual(Buffer.from([31, 139, 8, 0]));
  });

  it("keeps a configurable disk-safety limit for exceptionally large archives", async () => {
    const session = fakeSession();
    const archive = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha }), { status: 200 }),
      )
      .mockResolvedValueOnce(missingGitmodules())
      .mockResolvedValueOnce(new Response(archive, { status: 200 }));

    await expect(
      checkoutRuntimeRepositories(session, "version-id", {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        fetch: fetchMock,
        getRepositories: vi.fn().mockResolvedValue([
          {
            defaultBranch: "main",
            fullName: "example-org/too-large-repo",
            installationId: 123,
            private: true,
          },
        ]),
        maxArchiveBytes: 4,
        uploadArchive: uploadArchive(),
      }),
    ).rejects.toThrow("GitHub repository archive exceeds the 4 bytes limit");
  });

  it("stops fallback archive generation as soon as the disk-safety limit is crossed", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "responder-git-limit-test-"),
    );
    const binDirectory = join(temporaryDirectory, "bin");
    const gitPath = join(binDirectory, "git");
    const tarPath = join(binDirectory, "tar");
    const completionMarker = join(temporaryDirectory, "archive-completed");
    await mkdir(binDirectory);
    await writeFile(
      gitPath,
      [
        "#!/bin/sh",
        "case \" $* \" in",
        "  *\" rev-parse \"*) printf '%s\\n' \"$RESPONDER_TEST_GIT_SHA\" ;;",
        "  *\" worktree add \"*)",
        "    for argument do destination=\"${previous:-}\"; previous=\"$argument\"; done",
        "    mkdir -p \"$destination\"",
        "    ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    await writeFile(
      tarPath,
      [
        "#!/bin/sh",
        "printf '12345'",
        "sleep 1",
        ": > \"$RESPONDER_TEST_GIT_COMPLETED\"",
        "printf '6789'",
      ].join("\n"),
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${binDirectory}:${process.env.PATH ?? ""}`);
    vi.stubEnv("RESPONDER_TEST_GIT_SHA", sha);
    vi.stubEnv("RESPONDER_TEST_GIT_COMPLETED", completionMarker);

    try {
      await expect(
        checkoutRuntimeRepositories(fakeSession(), "version-id", {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
          getRepositories: vi.fn().mockResolvedValue([
            {
              defaultBranch: "main",
              fullName: "example-org/git-fallback-repo",
              installationId: 123,
              private: true,
            },
          ]),
          maxArchiveBytes: 4,
          temporaryDirectory,
        }),
      ).rejects.toThrow("GitHub repository archive exceeds the 4 bytes limit");
      await expect(access(completionMarker)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
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

  it("clears repositories and records an empty manifest when configuration changes", async () => {
    const session = fakeSession();

    await expect(
      refreshRuntimeRepositories(session, "version-id", {
        createInstallationToken: vi.fn(),
        fetch: vi.fn(),
        getRepositories: vi.fn().mockResolvedValue([]),
      }),
    ).resolves.toEqual([]);

    expect(session.execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining(
          "rm -rf '/home/daytona/workspace/repositories'",
        ),
      }),
    );
    expect(session.materializeEntry).toHaveBeenCalledWith({
      entry: {
        type: "file",
        content: '{\n  "repositories": []\n}\n',
      },
      path: "/home/daytona/workspace/.responder/repositories.json",
    });
  });
});
