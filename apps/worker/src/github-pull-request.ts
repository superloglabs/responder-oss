import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "@responder/core/integrations/github";
import { z } from "zod";
import { assertNoDaytonaSecretPlaceholders } from "./secret-safety.js";

const githubBlobSchema = z.object({ sha: z.string().min(1) });
const githubTreeSchema = z.object({ sha: z.string().min(1) });
const githubCommitSchema = z.object({ sha: z.string().min(1) });
const githubPullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
});

interface PullRequestDependencies {
  createInstallationToken: (installationId: number) => Promise<string>;
  fetch: typeof fetch;
}

const defaultDependencies: PullRequestDependencies = {
  createInstallationToken: createGitHubInstallationToken,
  fetch,
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function repositoryApiPath(fullName: string): string {
  const parts = fullName.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
  ) {
    throw new Error(`Invalid GitHub repository name: ${fullName}`);
  }
  return parts.map(encodeURIComponent).join("/");
}

function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42);
  return slug || "issue";
}

function execResult(output: string): { exitCode: number; stdout: string } {
  const match = /(?:^|\n)Process exited with code (\d+)(?:\n|$)/u.exec(output);
  return {
    exitCode: match ? Number(match[1]) : -1,
    stdout: output.split("\nOutput:\n", 2)[1] ?? "",
  };
}

async function runCommand(
  session: DaytonaSandboxSession,
  command: string,
  workdir: string,
) {
  return execResult(
    await session.execCommand({
      cmd: command,
      maxOutputTokens: 12_000,
      workdir,
    }),
  );
}

export async function githubJson(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      ...githubAppHeaders(token),
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof payload.message === "string"
        ? payload.message
        : `GitHub request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

export async function changedFiles(
  session: DaytonaSandboxSession,
  repositoryPath: string,
  workspaceBaseSha: string,
  allowEmpty = false,
): Promise<
  Array<{ content: Uint8Array | null; mode: "100644" | "100755"; path: string }>
> {
  const listed = await runCommand(
    session,
    [
      `git diff --name-only -z ${shellQuote(workspaceBaseSha)} --`,
      "git ls-files --others --exclude-standard -z",
    ].join(" && "),
    repositoryPath,
  );
  if (listed.exitCode !== 0) {
    throw new Error(`Unable to inspect repository changes: ${listed.stdout.trim()}`);
  }
  const paths = [...new Set(listed.stdout.split("\0").filter(Boolean))];
  if (paths.length === 0 && !allowEmpty) {
    throw new Error("No repository changes were made");
  }
  if (paths.length > 50) throw new Error("A pull request may change at most 50 files");

  const files: Array<{
    content: Uint8Array | null;
    mode: "100644" | "100755";
    path: string;
  }> = [];
  let totalBytes = 0;
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("Repository changes contain an unsafe path");
    }
    const absolutePath = `${repositoryPath}/${path}`;
    const state = await runCommand(
      session,
      [
        `if [ -L ${shellQuote(absolutePath)} ]; then printf symlink`,
        `elif [ -e ${shellQuote(absolutePath)} ]; then printf present`,
        "else printf deleted",
        "fi",
      ].join("; "),
      repositoryPath,
    );
    const fileState = state.stdout.trim();
    if (fileState === "symlink") {
      throw new Error(`Symbolic link changes are not supported: ${path}`);
    }
    if (fileState === "deleted") {
      files.push({ content: null, mode: "100644", path });
      continue;
    }
    if (fileState !== "present") {
      throw new Error(`Unable to inspect changed file: ${path}`);
    }
    const content = await session.readFile({ path: absolutePath });
    if (content.byteLength > 2 * 1024 * 1024) {
      throw new Error(`Changed file exceeds the 2 MB limit: ${path}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > 10 * 1024 * 1024) {
      throw new Error("Pull request changes exceed the 10 MB total limit");
    }
    const executable = await runCommand(
      session,
      `test -x ${shellQuote(absolutePath)}`,
      repositoryPath,
    );
    files.push({
      content,
      mode: executable.exitCode === 0 ? "100755" : "100644",
      path,
    });
  }
  return files;
}

export async function createPullRequestFromSandbox(
  input: {
    baseBranch: string;
    baseSha: string;
    body: string;
    installationId: number;
    repository: string;
    repositoryPath: string;
    requestId: string;
    title: string;
    workspaceBaseSha: string;
  },
  session: DaytonaSandboxSession,
  dependencies: PullRequestDependencies = defaultDependencies,
) {
  const files = await changedFiles(
    session,
    input.repositoryPath,
    input.workspaceBaseSha,
  );
  assertNoDaytonaSecretPlaceholders(input.body, "Pull request body");
  assertNoDaytonaSecretPlaceholders(input.title, "Pull request title");
  for (const file of files) {
    assertNoDaytonaSecretPlaceholders(file.path, "Changed file path");
    if (file.content) {
      assertNoDaytonaSecretPlaceholders(
        file.content,
        `Changed file ${file.path}`,
      );
    }
  }
  const token = await dependencies.createInstallationToken(input.installationId);
  const apiRepository = repositoryApiPath(input.repository);
  const apiBase = `https://api.github.com/repos/${apiRepository}`;
  const treeEntries: Array<{
    path: string;
    mode: "100644" | "100755";
    type: "blob";
    sha: string | null;
  }> = [];

  for (const file of files) {
    if (file.content === null) {
      treeEntries.push({ path: file.path, mode: file.mode, type: "blob", sha: null });
      continue;
    }
    const blob = githubBlobSchema.parse(
      await githubJson(dependencies.fetch, token, `${apiBase}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        }),
      }),
    );
    treeEntries.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
  }

  const tree = githubTreeSchema.parse(
    await githubJson(dependencies.fetch, token, `${apiBase}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: input.baseSha, tree: treeEntries }),
    }),
  );
  const commit = githubCommitSchema.parse(
    await githubJson(dependencies.fetch, token, `${apiBase}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: input.title,
        parents: [input.baseSha],
        tree: tree.sha,
      }),
    }),
  );
  const branch = `fix/${branchSlug(input.title)}-${input.requestId.slice(0, 8)}`;
  await githubJson(dependencies.fetch, token, `${apiBase}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  });
  const pullRequest = githubPullRequestSchema.parse(
    await githubJson(dependencies.fetch, token, `${apiBase}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        base: input.baseBranch,
        body: input.body,
        head: branch,
        title: input.title,
      }),
    }),
  );
  return {
    branch,
    changedFiles: files.map((file) => file.path),
    number: pullRequest.number,
    url: pullRequest.html_url,
  };
}
