import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  getRuntimeRepositories,
  type RuntimeRepository,
} from "@responder/core/db/investigations";
import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "@responder/core/integrations/github";
const maxArchiveBytes = 100 * 1024 * 1024;
const workspaceRoot = "/home/daytona/workspace";
const execFileAsync = promisify(execFile);

export interface CheckedOutRepository {
  branch: string;
  path: string;
  repository: string;
  sha: string;
  workspaceBaseSha: string;
}

export interface RepositoryCheckoutDependencies {
  createInstallationToken: (installationId: number) => Promise<string>;
  downloadWithGit?: (
    repository: RuntimeRepository,
    accessToken: string,
    ref: string,
  ) => Promise<{ archive: Uint8Array; sha: string }>;
  fetch: typeof fetch;
  getRepositories: (versionId: string) => Promise<RuntimeRepository[]>;
}

const defaultDependencies: RepositoryCheckoutDependencies = {
  createInstallationToken: createGitHubInstallationToken,
  fetch,
  getRepositories: getRuntimeRepositories,
};

async function downloadRepositorySnapshotWithGit(
  repository: RuntimeRepository,
  accessToken: string,
  ref: string,
): Promise<{ archive: Uint8Array; sha: string }> {
  const temporaryBase =
    process.env.RESPONDER_REPOSITORY_TEMP_DIR ?? tmpdir();
  const temporaryRoot = await mkdtemp(
    join(temporaryBase, "responder-repository-"),
  );
  const gitDirectory = join(temporaryRoot, "repository.git");
  const archivePath = join(temporaryRoot, "repository.tar.gz");
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${accessToken}`,
    GIT_TERMINAL_PROMPT: "0",
  };

  try {
    await mkdir(gitDirectory);
    await execFileAsync("git", ["-C", gitDirectory, "init", "--bare", "--quiet"], {
      timeout: 30_000,
    });
    await execFileAsync(
      "git",
      [
        "-C",
        gitDirectory,
        "remote",
        "add",
        "origin",
        `https://github.com/${repository.fullName}.git`,
      ],
      { timeout: 30_000 },
    );
    await execFileAsync(
      "git",
      [
        "-C",
        gitDirectory,
        "fetch",
        "--quiet",
        "--depth=1",
        "origin",
        ref,
      ],
      { env: gitEnvironment, timeout: 120_000 },
    );
    const { stdout } = await execFileAsync(
      "git",
      ["-C", gitDirectory, "rev-parse", "FETCH_HEAD"],
      { timeout: 30_000 },
    );
    const sha = stdout.trim();
    if (!/^[a-f0-9]{40}$/i.test(sha)) {
      throw new Error("Git returned an invalid repository commit");
    }
    await execFileAsync(
      "git",
      [
        "-C",
        gitDirectory,
        "archive",
        "--format=tar.gz",
        `--output=${archivePath}`,
        "FETCH_HEAD",
      ],
      { timeout: 120_000 },
    );
    const archiveStats = await stat(archivePath);
    if (archiveStats.size > maxArchiveBytes) {
      throw new Error("GitHub repository archive exceeds the 100 MB limit");
    }
    return { archive: new Uint8Array(await readFile(archivePath)), sha };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "GitHub repository archive exceeds the 100 MB limit"
    ) {
      throw error;
    }
    throw new Error(
      `Unable to download ${repository.fullName}@${ref} using Git fallback`,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeRepositoryParts(fullName: string): [string, string] {
  const parts = fullName.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) ||
        part === "." ||
        part === "..",
    )
  ) {
    throw new Error(`Invalid GitHub repository name: ${fullName}`);
  }
  return [parts[0]!, parts[1]!];
}

export function repositoryWorkspacePath(fullName: string): string {
  const [owner, repository] = safeRepositoryParts(fullName);
  return `${workspaceRoot}/repositories/${owner}/${repository}`;
}

function execSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

async function runSandboxCommand(
  session: DaytonaSandboxSession,
  command: string,
  label: string,
): Promise<string> {
  const output = await session.execCommand({
    cmd: command,
    maxOutputTokens: 2_000,
    workdir: workspaceRoot,
  });
  if (execSucceeded(output)) {
    return output.split("\nOutput:\n", 2)[1]?.trim() ?? "";
  }

  const detail = output.split("\nOutput:\n", 2)[1]?.trim();
  throw new Error(
    `Repository sandbox failed to ${label}${detail ? `: ${detail}` : ""}`,
  );
}

async function readResponseWithLimit(
  response: Response,
  limit = maxArchiveBytes,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error("GitHub repository archive exceeds the 100 MB limit");
  }
  if (!response.body) throw new Error("GitHub returned an empty archive");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        await reader.cancel();
        throw new Error("GitHub repository archive exceeds the 100 MB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const archive = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

function shouldUseGitFallback(response: Response): boolean {
  return (
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"))
  );
}

async function downloadExactSnapshotWithGit(
  repository: RuntimeRepository,
  accessToken: string,
  sha: string,
  downloadWithGit: NonNullable<
    RepositoryCheckoutDependencies["downloadWithGit"]
  >,
): Promise<{ archive: Uint8Array; sha: string }> {
  const fallback = await downloadWithGit(repository, accessToken, sha);
  if (fallback.sha !== sha) {
    throw new Error(`Git returned an unexpected commit for ${repository.fullName}`);
  }
  return fallback;
}

async function fetchRepositorySnapshot(
  repository: RuntimeRepository,
  accessToken: string,
  fetchImpl: typeof fetch,
  downloadWithGit: NonNullable<
    RepositoryCheckoutDependencies["downloadWithGit"]
  >,
): Promise<{ archive: Uint8Array; sha: string }> {
  const headers = githubAppHeaders(accessToken);
  const branch = encodeURIComponent(repository.defaultBranch);
  let commitResponse: Response;
  try {
    commitResponse = await fetchImpl(
      `https://api.github.com/repos/${repository.fullName}/commits/${branch}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
  } catch {
    return downloadWithGit(repository, accessToken, repository.defaultBranch);
  }
  if (!commitResponse.ok) {
    if (shouldUseGitFallback(commitResponse)) {
      await commitResponse.body?.cancel();
      return downloadWithGit(
        repository,
        accessToken,
        repository.defaultBranch,
      );
    }
    throw new Error(
      `Unable to resolve ${repository.fullName}@${repository.defaultBranch}`,
    );
  }
  const commit = (await commitResponse.json()) as { sha?: unknown };
  const sha = commit.sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(`GitHub returned an invalid commit for ${repository.fullName}`);
  }

  let archiveResponse: Response;
  try {
    archiveResponse = await fetchImpl(
      `https://api.github.com/repos/${repository.fullName}/tarball/${sha}`,
      { headers, signal: AbortSignal.timeout(60_000) },
    );
  } catch {
    return downloadExactSnapshotWithGit(
      repository,
      accessToken,
      sha,
      downloadWithGit,
    );
  }
  if (!archiveResponse.ok) {
    if (shouldUseGitFallback(archiveResponse)) {
      await archiveResponse.body?.cancel();
      return downloadExactSnapshotWithGit(
        repository,
        accessToken,
        sha,
        downloadWithGit,
      );
    }
    throw new Error(`Unable to download ${repository.fullName}@${sha}`);
  }
  return { archive: await readResponseWithLimit(archiveResponse), sha };
}

export async function checkoutRuntimeRepositories(
  session: DaytonaSandboxSession,
  versionId: string,
  dependencies: RepositoryCheckoutDependencies = defaultDependencies,
): Promise<CheckedOutRepository[]> {
  const repositories = await dependencies.getRepositories(versionId);
  if (repositories.length === 0) return [];

  const tokens = new Map<number, string>();
  const checkedOut: CheckedOutRepository[] = [];
  for (const repository of repositories) {
    let token = tokens.get(repository.installationId);
    if (!token) {
      token = await dependencies.createInstallationToken(
        repository.installationId,
      );
      tokens.set(repository.installationId, token);
    }

    const snapshot = await fetchRepositorySnapshot(
      repository,
      token,
      dependencies.fetch,
      dependencies.downloadWithGit ?? downloadRepositorySnapshotWithGit,
    );
    const [owner, name] = safeRepositoryParts(repository.fullName);
    const destination = repositoryWorkspacePath(repository.fullName);
    const archivePath =
      `${workspaceRoot}/.responder/archives/${owner}-${name}-${snapshot.sha}.tar.gz`;

    await session.materializeEntry({
      entry: { type: "file", content: snapshot.archive },
      path: archivePath,
    });
    const workspaceBaseSha = await runSandboxCommand(
      session,
      [
        "set -eu",
        `rm -rf ${shellQuote(destination)}`,
        `mkdir -p ${shellQuote(destination)}`,
        [
          `tar -xzf ${shellQuote(archivePath)}`,
          "--no-same-owner --no-same-permissions --strip-components=1",
          `-C ${shellQuote(destination)}`,
        ].join(" "),
        `rm -f ${shellQuote(archivePath)}`,
        `git -C ${shellQuote(destination)} init -q`,
        `git -C ${shellQuote(destination)} config user.name 'Responder Agent'`,
        `git -C ${shellQuote(destination)} config user.email 'agent@responder.invalid'`,
        `git -C ${shellQuote(destination)} add -A`,
        `git -C ${shellQuote(destination)} commit -q --allow-empty -m 'Responder workspace baseline'`,
        `git -C ${shellQuote(destination)} rev-parse HEAD`,
      ].join("\n"),
      `extract ${repository.fullName}`,
    );
    if (!/^[a-f0-9]{40}$/i.test(workspaceBaseSha)) {
      throw new Error(
        `Repository sandbox returned an invalid baseline for ${repository.fullName}`,
      );
    }

    checkedOut.push({
      branch: repository.defaultBranch,
      path: destination,
      repository: repository.fullName,
      sha: snapshot.sha,
      workspaceBaseSha,
    });
  }

  await session.materializeEntry({
    entry: {
      type: "file",
      content: `${JSON.stringify({ repositories: checkedOut }, null, 2)}\n`,
    },
    path: `${workspaceRoot}/.responder/repositories.json`,
  });
  return checkedOut;
}
