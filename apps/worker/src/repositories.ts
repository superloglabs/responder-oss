import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
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

export interface CheckedOutRepository {
  branch: string;
  path: string;
  repository: string;
  sha: string;
  workspaceBaseSha: string;
}

export interface RepositoryCheckoutDependencies {
  createInstallationToken: (installationId: number) => Promise<string>;
  fetch: typeof fetch;
  getRepositories: (versionId: string) => Promise<RuntimeRepository[]>;
}

const defaultDependencies: RepositoryCheckoutDependencies = {
  createInstallationToken: createGitHubInstallationToken,
  fetch,
  getRepositories: getRuntimeRepositories,
};

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

async function fetchRepositorySnapshot(
  repository: RuntimeRepository,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<{ archive: Uint8Array; sha: string }> {
  const headers = githubAppHeaders(accessToken);
  const branch = encodeURIComponent(repository.defaultBranch);
  const commitResponse = await fetchImpl(
    `https://api.github.com/repos/${repository.fullName}/commits/${branch}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!commitResponse.ok) {
    throw new Error(
      `Unable to resolve ${repository.fullName}@${repository.defaultBranch}`,
    );
  }
  const commit = (await commitResponse.json()) as { sha?: unknown };
  const sha = commit.sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(`GitHub returned an invalid commit for ${repository.fullName}`);
  }

  const archiveResponse = await fetchImpl(
    `https://api.github.com/repos/${repository.fullName}/tarball/${sha}`,
    { headers, signal: AbortSignal.timeout(60_000) },
  );
  if (!archiveResponse.ok) {
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
