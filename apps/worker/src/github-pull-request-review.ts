import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "@responder/core/integrations/github";
import { z } from "zod";
import { assertNoDaytonaSecretPlaceholders } from "./secret-safety.js";
import {
  changedFiles,
  githubJson,
  repositoryApiPath,
} from "./github-pull-request.js";

const reviewThreadSchema = z.object({
  id: z.string().min(1),
  isOutdated: z.boolean(),
  isResolved: z.boolean(),
  comments: z.object({
    nodes: z.array(
      z.object({
        author: z
          .object({
            login: z.string().min(1),
            __typename: z.string().min(1),
          })
          .nullable(),
        body: z.string(),
        id: z.string().min(1),
        line: z.number().int().nullable(),
        originalLine: z.number().int().nullable(),
        path: z.string().min(1),
        url: z.string().url(),
      }),
    ),
  }),
});

const reviewThreadsResponseSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          headRefName: z.string().min(1),
          headRefOid: z.string().regex(/^[a-f0-9]{40}$/i),
          headRepository: z
            .object({ nameWithOwner: z.string().min(1) })
            .nullable(),
          reviewThreads: z.object({
            nodes: z.array(reviewThreadSchema),
            pageInfo: z.object({
              endCursor: z.string().nullable(),
              hasNextPage: z.boolean(),
            }),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

const githubBlobSchema = z.object({ sha: z.string().min(1) });
const githubTreeSchema = z.object({ sha: z.string().min(1) });
const githubCommitSchema = z.object({ sha: z.string().min(1) });
const githubCommitDetailsSchema = z.object({
  tree: z.object({ sha: z.string().min(1) }),
});
const reviewThreadStateSchema = z.object({
  node: z
    .object({
      comments: z.object({
        nodes: z.array(z.object({ body: z.string() })),
      }),
      isResolved: z.boolean(),
    })
    .nullable(),
});

interface ReviewDependencies {
  createInstallationToken: (installationId: number) => Promise<string>;
  fetch: typeof fetch;
}

const defaultDependencies: ReviewDependencies = {
  createInstallationToken: createGitHubInstallationToken,
  fetch,
};

export interface BotReviewThread {
  author: string;
  body: string;
  id: string;
  line: number | null;
  path: string;
  url: string;
}

export interface PullRequestReviewState {
  branch: string;
  headSha: string;
  threads: BotReviewThread[];
}

function repositoryParts(fullName: string): [string, string] {
  repositoryApiPath(fullName);
  const [owner, name] = fullName.split("/");
  return [owner!, name!];
}

async function githubGraphql(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
    headers: {
      ...githubAppHeaders(token),
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: unknown;
    errors?: Array<{ message?: unknown }>;
    message?: unknown;
  } | null;
  const graphErrorValue = payload?.errors?.find(
    (error) => typeof error.message === "string",
  )?.message;
  const graphError =
    typeof graphErrorValue === "string" ? graphErrorValue : undefined;
  if (!response.ok || graphError || payload?.data === undefined) {
    const message =
      graphError ??
      (typeof payload?.message === "string"
        ? payload.message
        : `GitHub request failed (${response.status})`);
    throw new Error(message);
  }
  return payload.data;
}

export async function listUnresolvedBotReviewThreads(
  input: {
    installationId: number;
    pullRequestNumber: number;
    repository: string;
  },
  dependencies: ReviewDependencies = defaultDependencies,
): Promise<PullRequestReviewState> {
  const token = await dependencies.createInstallationToken(input.installationId);
  const [owner, name] = repositoryParts(input.repository);
  const threads: BotReviewThread[] = [];
  let after: string | null = null;
  let branch: string | undefined;
  let headSha: string | undefined;

  do {
    const data = reviewThreadsResponseSchema.parse(
      await githubGraphql(
        dependencies.fetch,
        token,
        `query ResponderReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              headRefName
              headRefOid
              headRepository { nameWithOwner }
              reviewThreads(first: 100, after: $after) {
                nodes {
                  id
                  isOutdated
                  isResolved
                  comments(first: 100) {
                    nodes {
                      author { login __typename }
                      body
                      id
                      line
                      originalLine
                      path
                      url
                    }
                  }
                }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        { after, name, number: input.pullRequestNumber, owner },
      ),
    );
    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) throw new Error("Pull request is unavailable");
    if (pullRequest.headRepository?.nameWithOwner !== input.repository) {
      throw new Error("Pull requests from forked repositories are not supported");
    }
    branch = pullRequest.headRefName;
    headSha = pullRequest.headRefOid;

    for (const thread of pullRequest.reviewThreads.nodes) {
      const comment = thread.comments.nodes[0];
      if (
        thread.isResolved ||
        !comment ||
        comment.author?.__typename !== "Bot"
      ) {
        continue;
      }
      threads.push({
        author: comment.author.login,
        body: comment.body,
        id: thread.id,
        line: comment.line ?? comment.originalLine,
        path: comment.path,
        url: comment.url,
      });
    }
    after = pullRequest.reviewThreads.pageInfo.hasNextPage
      ? pullRequest.reviewThreads.pageInfo.endCursor
      : null;
  } while (after);

  if (!branch || !headSha) throw new Error("Pull request head is unavailable");
  return { branch, headSha, threads };
}

export async function publishPullRequestReviewChanges(
  input: {
    branch: string;
    commitMessage: string;
    headSha: string;
    installationId: number;
    repository: string;
    repositoryPath: string;
    workspaceBaseSha: string;
  },
  session: DaytonaSandboxSession,
  dependencies: ReviewDependencies = defaultDependencies,
): Promise<{ changedFiles: string[]; headSha: string }> {
  const files = await changedFiles(
    session,
    input.repositoryPath,
    input.workspaceBaseSha,
    true,
  );
  if (files.length === 0) {
    return { changedFiles: [], headSha: input.headSha };
  }

  assertNoDaytonaSecretPlaceholders(input.commitMessage, "Commit message");
  for (const file of files) {
    assertNoDaytonaSecretPlaceholders(file.path, "Changed file path");
    if (file.content) {
      assertNoDaytonaSecretPlaceholders(file.content, `Changed file ${file.path}`);
    }
  }

  const token = await dependencies.createInstallationToken(input.installationId);
  const apiBase = `https://api.github.com/repos/${repositoryApiPath(input.repository)}`;
  const headCommit = githubCommitDetailsSchema.parse(
    await githubJson(
      dependencies.fetch,
      token,
      `${apiBase}/git/commits/${encodeURIComponent(input.headSha)}`,
      { method: "GET" },
    ),
  );
  const treeEntries: Array<{
    mode: "100644" | "100755";
    path: string;
    sha: string | null;
    type: "blob";
  }> = [];
  for (const file of files) {
    if (!file.content) {
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
      body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: treeEntries }),
    }),
  );
  const commit = githubCommitSchema.parse(
    await githubJson(dependencies.fetch, token, `${apiBase}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: input.commitMessage,
        parents: [input.headSha],
        tree: tree.sha,
      }),
    }),
  );
  const encodedBranch = input.branch.split("/").map(encodeURIComponent).join("/");
  await githubJson(
    dependencies.fetch,
    token,
    `${apiBase}/git/refs/heads/${encodedBranch}`,
    {
      method: "PATCH",
      body: JSON.stringify({ force: false, sha: commit.sha }),
    },
  );
  return { changedFiles: files.map((file) => file.path), headSha: commit.sha };
}

export async function replyToAndResolveReviewThreads(
  input: {
    installationId: number;
    responses: Array<{ body: string; threadId: string }>;
  },
  dependencies: ReviewDependencies = defaultDependencies,
): Promise<void> {
  const token = await dependencies.createInstallationToken(input.installationId);
  for (const response of input.responses) {
    assertNoDaytonaSecretPlaceholders(response.body, "Review reply");
    const marker = `<!-- responder-review-thread:${response.threadId} -->`;
    await retryReviewOperation(async () => {
      const state = reviewThreadStateSchema.parse(
        await githubGraphql(
          dependencies.fetch,
          token,
          `query ResponderReviewThreadState($threadId: ID!) {
            node(id: $threadId) {
              ... on PullRequestReviewThread {
                isResolved
                comments(first: 100) { nodes { body } }
              }
            }
          }`,
          { threadId: response.threadId },
        ),
      ).node;
      if (!state) throw new Error("Pull request review thread is unavailable");
      if (state.isResolved) return;

      if (!state.comments.nodes.some((comment) => comment.body.includes(marker))) {
        await githubGraphql(
          dependencies.fetch,
          token,
          `mutation ResponderReplyToReviewThread($threadId: ID!, $body: String!) {
            addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
              comment { id }
            }
          }`,
          { body: `${response.body}\n\n${marker}`, threadId: response.threadId },
        );
      }
      await githubGraphql(
        dependencies.fetch,
        token,
        `mutation ResponderResolveReviewThread($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }`,
        { threadId: response.threadId },
      );
    });
  }
}

async function retryReviewOperation(operation: () => Promise<void>) {
  let failure: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

export function assertPullRequestReviewStateCurrent(
  expected: PullRequestReviewState,
  current: PullRequestReviewState,
  threadIds: ReadonlySet<string>,
): void {
  if (
    current.branch !== expected.branch ||
    current.headSha !== expected.headSha
  ) {
    throw new Error("Pull request head changed during review follow-up");
  }
  const currentThreadIds = new Set(current.threads.map((thread) => thread.id));
  if ([...threadIds].some((threadId) => !currentThreadIds.has(threadId))) {
    throw new Error("Pull request review threads changed during follow-up");
  }
}
