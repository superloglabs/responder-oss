import { Daytona } from "@daytona/sdk";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  getRuntimeRepositories,
  type RuntimeRepository,
} from "@responder/core/db/investigations";
import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "@responder/core/integrations/github";
const defaultMaxArchiveBytes = 5 * 1024 * 1024 * 1024;
const repositoryDownloadTimeoutMs = 10 * 60_000;
const repositoryUploadTimeoutSeconds = 30 * 60;
const workspaceRoot = "/home/daytona/workspace";
const execFileAsync = promisify(execFile);

class RepositoryArchiveLimitError extends Error {
  constructor(limit: number) {
    super(
      `GitHub repository archive exceeds the ${formatByteLimit(limit)} limit`,
    );
    this.name = "RepositoryArchiveLimitError";
  }
}

function formatByteLimit(bytes: number): string {
  const gibibyte = 1024 * 1024 * 1024;
  const mebibyte = 1024 * 1024;
  if (bytes % gibibyte === 0) return `${bytes / gibibyte} GB`;
  if (bytes % mebibyte === 0) return `${bytes / mebibyte} MB`;
  return `${bytes} byte${bytes === 1 ? "" : "s"}`;
}

function repositoryArchiveLimit(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configured = environment.RESPONDER_REPOSITORY_ARCHIVE_MAX_BYTES;
  if (!configured) return defaultMaxArchiveBytes;
  if (!/^\d+$/.test(configured)) {
    throw new Error(
      "RESPONDER_REPOSITORY_ARCHIVE_MAX_BYTES must be a positive integer",
    );
  }
  const limit = Number(configured);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(
      "RESPONDER_REPOSITORY_ARCHIVE_MAX_BYTES must be a positive safe integer",
    );
  }
  return limit;
}

async function writeStreamWithLimit(
  source: Readable,
  archivePath: string,
  limit: number,
): Promise<void> {
  let byteLength = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteLength += chunk.byteLength;
      if (byteLength > limit) {
        callback(new RepositoryArchiveLimitError(limit));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    source,
    limiter,
    createWriteStream(archivePath, { flags: "wx" }),
  );
}

export interface CheckedOutRepository {
  branch: string;
  path: string;
  repository: string;
  sha: string;
  workspaceBaseSha: string;
}

export interface RuntimeRepositoryReference {
  branch: string;
  sha: string;
}

export interface RepositoryCheckoutDependencies {
  createInstallationToken: (installationId: number) => Promise<string>;
  downloadWithGit?: (
    repository: RuntimeRepository,
    accessToken: string,
    ref: string,
    archivePath: string,
    archiveLimitBytes: number,
  ) => Promise<{ sha: string }>;
  fetch: typeof fetch;
  getRepositories: (versionId: string) => Promise<RuntimeRepository[]>;
  maxArchiveBytes?: number;
  temporaryDirectory?: string;
  uploadArchive?: (
    session: DaytonaSandboxSession,
    localPath: string,
    remotePath: string,
  ) => Promise<void>;
}

const defaultDependencies: RepositoryCheckoutDependencies = {
  createInstallationToken: createGitHubInstallationToken,
  fetch,
  getRepositories: getRuntimeRepositories,
};

async function writeGitArchiveWithLimit(
  gitDirectory: string,
  archivePath: string,
  archiveLimitBytes: number,
): Promise<void> {
  const archiveProcess = spawn(
    "git",
    ["-C", gitDirectory, "archive", "--format=tar.gz", "FETCH_HEAD"],
    {
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: repositoryDownloadTimeoutMs,
    },
  );
  const completed = new Promise<void>((resolve, reject) => {
    archiveProcess.once("error", reject);
    archiveProcess.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Git archive exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
  const writeArchive = writeStreamWithLimit(
    archiveProcess.stdout,
    archivePath,
    archiveLimitBytes,
  );

  try {
    await Promise.all([completed, writeArchive]);
  } catch (error) {
    archiveProcess.stdout.destroy();
    if (archiveProcess.exitCode === null && archiveProcess.signalCode === null) {
      archiveProcess.kill("SIGKILL");
    }
    await Promise.allSettled([completed, writeArchive]);
    throw error;
  }
}

async function downloadRepositorySnapshotWithGit(
  repository: RuntimeRepository,
  accessToken: string,
  ref: string,
  archivePath: string,
  archiveLimitBytes: number,
): Promise<{ sha: string }> {
  const temporaryRoot = dirname(archivePath);
  const gitDirectory = join(temporaryRoot, "repository.git");
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
      { env: gitEnvironment, timeout: repositoryDownloadTimeoutMs },
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
    await writeGitArchiveWithLimit(
      gitDirectory,
      archivePath,
      archiveLimitBytes,
    );
    return { sha };
  } catch (error) {
    if (error instanceof RepositoryArchiveLimitError) throw error;
    throw new Error(
      `Unable to download ${repository.fullName}@${ref} using Git fallback`,
    );
  }
}

async function uploadRepositoryArchive(
  session: DaytonaSandboxSession,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const { apiKey, apiUrl, sandboxId, target } = session.state;
  if (!apiKey) throw new Error("Daytona API key is unavailable for file upload");

  const client = new Daytona({ apiKey, apiUrl, target });
  try {
    const sandbox = await client.get(sandboxId);
    await sandbox.fs.uploadFileStream(localPath, remotePath, {
      timeout: repositoryUploadTimeoutSeconds,
    });
  } finally {
    await client[Symbol.asyncDispose]().catch(() => undefined);
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

async function writeResponseWithLimit(
  response: Response,
  archivePath: string,
  limit: number,
): Promise<void> {
  const declaredLengthHeader = response.headers.get("content-length");
  const declaredLength = Number(declaredLengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new RepositoryArchiveLimitError(limit);
  }
  if (!response.body) throw new Error("GitHub returned an empty archive");
  await writeStreamWithLimit(
    Readable.from(response.body as AsyncIterable<Uint8Array>),
    archivePath,
    limit,
  );
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
  archivePath: string,
  archiveLimitBytes: number,
  downloadWithGit: NonNullable<
    RepositoryCheckoutDependencies["downloadWithGit"]
  >,
): Promise<{ sha: string }> {
  const fallback = await downloadWithGit(
    repository,
    accessToken,
    sha,
    archivePath,
    archiveLimitBytes,
  );
  if (fallback.sha !== sha) {
    throw new Error(`Git returned an unexpected commit for ${repository.fullName}`);
  }
  return fallback;
}

async function fetchRepositorySnapshot(
  repository: RuntimeRepository,
  accessToken: string,
  fetchImpl: typeof fetch,
  archivePath: string,
  archiveLimitBytes: number,
  downloadWithGit: NonNullable<
    RepositoryCheckoutDependencies["downloadWithGit"]
  >,
  reference?: RuntimeRepositoryReference,
): Promise<{ sha: string }> {
  const headers = githubAppHeaders(accessToken);
  if (reference && !/^[a-f0-9]{40}$/i.test(reference.sha)) {
    throw new Error(`Invalid commit for ${repository.fullName}`);
  }
  let sha: string;
  if (reference) {
    sha = reference.sha;
  } else {
    const branch = encodeURIComponent(repository.defaultBranch);
    let commitResponse: Response;
    try {
      commitResponse = await fetchImpl(
        `https://api.github.com/repos/${repository.fullName}/commits/${branch}`,
        { headers, signal: AbortSignal.timeout(30_000) },
      );
    } catch {
      return downloadWithGit(
        repository,
        accessToken,
        repository.defaultBranch,
        archivePath,
        archiveLimitBytes,
      );
    }
    if (!commitResponse.ok) {
      if (shouldUseGitFallback(commitResponse)) {
        await commitResponse.body?.cancel();
        return downloadWithGit(
          repository,
          accessToken,
          repository.defaultBranch,
          archivePath,
          archiveLimitBytes,
        );
      }
      throw new Error(
        `Unable to resolve ${repository.fullName}@${repository.defaultBranch}`,
      );
    }
    const commit = (await commitResponse.json()) as { sha?: unknown };
    if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/i.test(commit.sha)) {
      throw new Error(
        `GitHub returned an invalid commit for ${repository.fullName}`,
      );
    }
    sha = commit.sha;
  }

  let archiveResponse: Response;
  try {
    archiveResponse = await fetchImpl(
      `https://api.github.com/repos/${repository.fullName}/tarball/${sha}`,
      { headers, signal: AbortSignal.timeout(repositoryDownloadTimeoutMs) },
    );
  } catch {
    return downloadExactSnapshotWithGit(
      repository,
      accessToken,
      sha,
      archivePath,
      archiveLimitBytes,
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
        archivePath,
        archiveLimitBytes,
        downloadWithGit,
      );
    }
    throw new Error(`Unable to download ${repository.fullName}@${sha}`);
  }
  try {
    await writeResponseWithLimit(
      archiveResponse,
      archivePath,
      archiveLimitBytes,
    );
  } catch (error) {
    if (error instanceof RepositoryArchiveLimitError) throw error;
    await rm(archivePath, { force: true });
    return downloadExactSnapshotWithGit(
      repository,
      accessToken,
      sha,
      archivePath,
      archiveLimitBytes,
      downloadWithGit,
    );
  }
  return { sha };
}

export async function checkoutRuntimeRepositories(
  session: DaytonaSandboxSession,
  versionId: string,
  dependencies: RepositoryCheckoutDependencies = defaultDependencies,
): Promise<CheckedOutRepository[]> {
  return checkoutRuntimeRepositoriesWithRefs(
    session,
    versionId,
    new Map(),
    dependencies,
  );
}

export async function checkoutRuntimeRepositoriesAtRefs(
  session: DaytonaSandboxSession,
  versionId: string,
  references: ReadonlyMap<string, RuntimeRepositoryReference>,
  dependencies: RepositoryCheckoutDependencies = defaultDependencies,
): Promise<CheckedOutRepository[]> {
  return checkoutRuntimeRepositoriesWithRefs(
    session,
    versionId,
    references,
    dependencies,
  );
}

async function checkoutRuntimeRepositoriesWithRefs(
  session: DaytonaSandboxSession,
  versionId: string,
  references: ReadonlyMap<string, RuntimeRepositoryReference>,
  dependencies: RepositoryCheckoutDependencies,
): Promise<CheckedOutRepository[]> {
  const repositories = await dependencies.getRepositories(versionId);
  if (repositories.length === 0) return [];

  const archiveLimitBytes =
    dependencies.maxArchiveBytes ?? repositoryArchiveLimit();
  const temporaryDirectory =
    dependencies.temporaryDirectory ??
    process.env.RESPONDER_REPOSITORY_TEMP_DIR ??
    tmpdir();
  const uploadArchive = dependencies.uploadArchive ?? uploadRepositoryArchive;
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

    const [owner, name] = safeRepositoryParts(repository.fullName);
    const destination = repositoryWorkspacePath(repository.fullName);
    const temporaryRoot = await mkdtemp(
      join(temporaryDirectory, "responder-repository-"),
    );
    const localArchivePath = join(temporaryRoot, "repository.tar.gz");
    try {
      const snapshot = await fetchRepositorySnapshot(
        repository,
        token,
        dependencies.fetch,
        localArchivePath,
        archiveLimitBytes,
        dependencies.downloadWithGit ?? downloadRepositorySnapshotWithGit,
        references.get(repository.fullName),
      );
      const archivePath =
        `${workspaceRoot}/.responder/archives/${owner}-${name}-${snapshot.sha}.tar.gz`;

      await uploadArchive(session, localArchivePath, archivePath);
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
        branch:
          references.get(repository.fullName)?.branch ?? repository.defaultBranch,
        path: destination,
        repository: repository.fullName,
        sha: snapshot.sha,
        workspaceBaseSha,
      });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
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
