import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "@responder/core/integrations/github";
import { z } from "zod";
import {
  changedFiles,
  githubJson,
  repositoryApiPath,
} from "./github-pull-request.js";
import {
  saveCheckedOutRepositories,
  type CheckedOutRepository,
  type RuntimeRepositoryReference,
} from "./repositories.js";
import { assertNoDaytonaSecretPlaceholders } from "./secret-safety.js";

// Follow-up work on a pull request that a tag mode thread or an automation
// run opened: bring its branch into the checkout, push more commits to it,
// and answer its review comments. GitHub credentials stay in the worker.
//
// A checkout of a pull request has the head commit as its baseline, so the
// working tree's changes from the baseline are exactly what the next push
// adds. Each push moves the baseline to the commit it pushed.

const pullRequestSchema = z.object({
  head: z.object({
    ref: z.string().min(1),
    repo: z.object({ full_name: z.string().min(1) }).nullable(),
    sha: z.string().regex(/^[a-f0-9]{40}$/i),
  }),
  html_url: z.string().url(),
  state: z.string(),
});
const githubBlobSchema = z.object({ sha: z.string().min(1) });
const githubTreeSchema = z.object({ sha: z.string().min(1) });
const githubCommitSchema = z.object({ sha: z.string().min(1) });
const githubCommitDetailsSchema = z.object({
  tree: z.object({ sha: z.string().min(1) }),
});

export interface PullRequestFollowUpDependencies {
  createInstallationToken: (installationId: number) => Promise<string>;
  fetch: typeof fetch;
}

const defaultDependencies: PullRequestFollowUpDependencies = {
  createInstallationToken: createGitHubInstallationToken,
  fetch,
};

export interface PullRequestTarget {
  installationId: number;
  number: number;
  repository: string;
}

export interface PullRequestHead {
  branch: string;
  sha: string;
  url: string;
}

export async function getPullRequestHead(
  target: PullRequestTarget,
  dependencies: PullRequestFollowUpDependencies = defaultDependencies,
): Promise<PullRequestHead> {
  const token = await dependencies.createInstallationToken(target.installationId);
  const pullRequest = pullRequestSchema.parse(
    await githubJson(
      dependencies.fetch,
      token,
      `https://api.github.com/repos/${repositoryApiPath(target.repository)}/pulls/${target.number}`,
      { method: "GET" },
    ),
  );
  if (pullRequest.head.repo?.full_name !== target.repository) {
    throw new Error("Pull requests from forked repositories are not supported");
  }
  if (pullRequest.state !== "open") {
    throw new Error(`Pull request #${target.number} is ${pullRequest.state}`);
  }
  return {
    branch: pullRequest.head.ref,
    sha: pullRequest.head.sha,
    url: pullRequest.html_url,
  };
}

// Replaces the repository's checkout with the pull request's head commit,
// unless it is already there. Changes the old checkout had since its
// baseline are first saved as a patch beside it, since they may not have
// been pushed. `repositories` is updated in place so the run's other tools
// see the new checkout.
export async function checkoutPullRequest(
  input: {
    checkoutAtRef: (reference: RuntimeRepositoryReference) => Promise<CheckedOutRepository>;
    repositories: CheckedOutRepository[];
    session: DaytonaSandboxSession;
    target: PullRequestTarget;
  },
  dependencies: PullRequestFollowUpDependencies = defaultDependencies,
): Promise<{
  checkout: CheckedOutRepository;
  head: PullRequestHead;
  replaced: boolean;
  savedChanges?: string;
}> {
  const head = await getPullRequestHead(input.target, dependencies);
  const index = input.repositories.findIndex(
    (repository) => repository.repository === input.target.repository,
  );
  const current = input.repositories[index];
  if (current && current.branch === head.branch && current.sha === head.sha) {
    return { checkout: current, head, replaced: false };
  }
  const savedChanges = current
    ? await saveCheckoutChanges(input.session, current)
    : undefined;
  const checkout = await input.checkoutAtRef({ branch: head.branch, sha: head.sha });
  if (index >= 0) input.repositories[index] = checkout;
  else input.repositories.push(checkout);
  await saveCheckedOutRepositories(input.session, input.repositories);
  return { checkout, head, replaced: true, ...(savedChanges ? { savedChanges } : {}) };
}

// Writes the checkout's changes since its baseline, including new files, to a
// patch outside the checkout. Returns its path, or nothing without changes.
async function saveCheckoutChanges(
  session: DaytonaSandboxSession,
  checkout: CheckedOutRepository,
): Promise<string | undefined> {
  const name = checkout.repository.split("/").at(-1) ?? "repository";
  const patch = `${checkout.path.slice(0, checkout.path.lastIndexOf("/"))}/${name}-unpushed-${Date.now()}.patch`;
  const repository = shellQuote(checkout.path);
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      `git -C ${repository} add -A`,
      `if git -C ${repository} diff --cached --quiet ${checkout.workspaceBaseSha}; then echo none; else git -C ${repository} diff --cached --binary ${checkout.workspaceBaseSha} > ${shellQuote(patch)}; echo saved; fi`,
    ].join("\n"),
    maxOutputTokens: 2_000,
    workdir: checkout.path,
  });
  if (!execSucceeded(output)) {
    throw new Error(`Unable to save the changes in ${checkout.repository} before replacing its checkout`);
  }
  return output.split("\nOutput:\n", 2)[1]?.trim().endsWith("saved") ? patch : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function execSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

// Pushes the checkout's changes since its baseline as one commit on the pull
// request's branch. GitHub only accepts a commit whose parent is the current
// head, so commits pushed by someone else are never overwritten.
export async function updatePullRequest(
  input: {
    commitMessage: string;
    repositories: CheckedOutRepository[];
    session: DaytonaSandboxSession;
    target: PullRequestTarget;
  },
  dependencies: PullRequestFollowUpDependencies = defaultDependencies,
): Promise<{ changedFiles: string[]; headSha: string; url: string }> {
  const index = input.repositories.findIndex(
    (repository) => repository.repository === input.target.repository,
  );
  const checkout = input.repositories[index];
  const head = await getPullRequestHead(input.target, dependencies);
  if (!checkout || checkout.branch !== head.branch) {
    throw new Error(
      `The checkout of ${input.target.repository} is not pull request #${input.target.number}. Call checkout_pull_request first, then make the changes again.`,
    );
  }
  if (checkout.sha !== head.sha) {
    throw new Error(
      `Pull request #${input.target.number} has commits the checkout does not have. Call checkout_pull_request to get them; it replaces the checkout, so make your changes again afterwards.`,
    );
  }

  const files = await changedFiles(input.session, checkout.path, checkout.workspaceBaseSha, true);
  if (files.length === 0) {
    return { changedFiles: [], headSha: head.sha, url: head.url };
  }
  assertNoDaytonaSecretPlaceholders(input.commitMessage, "Commit message");
  for (const file of files) {
    assertNoDaytonaSecretPlaceholders(file.path, "Changed file path");
    if (file.content) {
      assertNoDaytonaSecretPlaceholders(file.content, `Changed file ${file.path}`);
    }
  }

  const token = await dependencies.createInstallationToken(input.target.installationId);
  const apiBase = `https://api.github.com/repos/${repositoryApiPath(input.target.repository)}`;
  const headCommit = githubCommitDetailsSchema.parse(
    await githubJson(dependencies.fetch, token, `${apiBase}/git/commits/${head.sha}`, {
      method: "GET",
    }),
  );
  const treeEntries: Array<{
    mode: "100644" | "100755";
    path: string;
    sha: string | null;
    type: "blob";
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
      body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: treeEntries }),
    }),
  );
  const commit = githubCommitSchema.parse(
    await githubJson(dependencies.fetch, token, `${apiBase}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: input.commitMessage,
        parents: [head.sha],
        tree: tree.sha,
      }),
    }),
  );
  // Checked again just before the branch moves: a branch reset to an older
  // commit in the meantime would otherwise accept this commit as a fast
  // forward and bring back the commits it dropped.
  const latest = await getPullRequestHead(input.target, dependencies);
  if (latest.branch !== head.branch || latest.sha !== head.sha) {
    throw new Error(
      `Pull request #${input.target.number} changed while the commit was prepared. Call checkout_pull_request to get its latest commit, then make your changes again.`,
    );
  }
  const encodedBranch = head.branch.split("/").map(encodeURIComponent).join("/");
  await githubJson(dependencies.fetch, token, `${apiBase}/git/refs/heads/${encodedBranch}`, {
    method: "PATCH",
    body: JSON.stringify({ force: false, sha: commit.sha }),
  });

  // The pushed state becomes the baseline for the next push.
  const repository = shellQuote(checkout.path);
  const output = await input.session.execCommand({
    cmd: [
      "set -eu",
      `git -C ${repository} add -A`,
      `git -C ${repository} commit -q --allow-empty -m ${shellQuote(`Pushed ${commit.sha}`)}`,
      `git -C ${repository} rev-parse HEAD`,
    ].join("\n"),
    maxOutputTokens: 2_000,
    workdir: checkout.path,
  });
  const baseline = output.split("\nOutput:\n", 2)[1]?.trim().split("\n").at(-1)?.trim() ?? "";
  if (!execSucceeded(output) || !/^[a-f0-9]{40}$/i.test(baseline)) {
    throw new Error(
      `Pushed ${commit.sha} to pull request #${input.target.number}, but the checkout could not record it. Call checkout_pull_request before changing the pull request again.`,
    );
  }
  input.repositories[index] = { ...checkout, sha: commit.sha, workspaceBaseSha: baseline };
  await saveCheckedOutRepositories(input.session, input.repositories);
  return { changedFiles: files.map((file) => file.path), headSha: commit.sha, url: head.url };
}

const reviewCommentSchema = z.object({
  id: z.number().int().positive(),
  in_reply_to_id: z.number().int().positive().optional(),
  pull_request_url: z.string().url(),
});

const reviewThreadsSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        nodes: z.array(z.object({
          comments: z.object({
            nodes: z.array(z.object({ databaseId: z.number().int().nullable() })),
          }),
          id: z.string().min(1),
          isResolved: z.boolean(),
        })),
        pageInfo: z.object({
          endCursor: z.string().nullable(),
          hasNextPage: z.boolean(),
        }),
      }),
    }).nullable(),
  }).nullable(),
});

async function githubGraphql(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl("https://api.github.com/graphql", {
    body: JSON.stringify({ query, variables }),
    headers: { ...githubAppHeaders(token), "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: unknown;
    errors?: Array<{ message?: unknown }>;
  } | null;
  const error = payload?.errors?.find((item) => typeof item.message === "string")?.message;
  if (!response.ok || error || payload?.data === undefined) {
    throw new Error(typeof error === "string" ? error : `GitHub request failed (${response.status})`);
  }
  return payload.data;
}

// Replies in the review thread that holds the comment, and resolves the
// thread when asked. Any comment in the thread can be named. A failed
// resolve is reported in the result, so the reply is not posted twice.
export async function replyToPullRequestComment(
  input: {
    body: string;
    commentId: number;
    resolve: boolean;
    target: PullRequestTarget;
  },
  dependencies: PullRequestFollowUpDependencies = defaultDependencies,
): Promise<{ resolved: boolean; resolveError?: string }> {
  assertNoDaytonaSecretPlaceholders(input.body, "Review reply");
  const token = await dependencies.createInstallationToken(input.target.installationId);
  const repositoryPath = repositoryApiPath(input.target.repository);
  const pullRequestUrl = `https://api.github.com/repos/${repositoryPath}/pulls/${input.target.number}`;
  const notOnPullRequest = new Error(
    `Comment ${input.commentId} is not a review comment on pull request #${input.target.number}`,
  );
  let comment: z.infer<typeof reviewCommentSchema>;
  try {
    comment = reviewCommentSchema.parse(await githubJson(
      dependencies.fetch,
      token,
      `https://api.github.com/repos/${repositoryPath}/pulls/comments/${input.commentId}`,
      { method: "GET" },
    ));
  } catch {
    throw notOnPullRequest;
  }
  if (comment.pull_request_url.toLowerCase() !== pullRequestUrl.toLowerCase()) throw notOnPullRequest;
  // A thread is named by its first comment; replies point to it.
  const rootId = comment.in_reply_to_id ?? comment.id;

  const [owner, name] = repositoryPath.split("/").map(decodeURIComponent);
  let after: string | null = null;
  let thread: { id: string; isResolved: boolean } | undefined;
  do {
    const data = reviewThreadsSchema.parse(await githubGraphql(
      dependencies.fetch,
      token,
      `query ResponderReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
              pageInfo { endCursor hasNextPage }
            }
          }
        }
      }`,
      { after, name, number: input.target.number, owner },
    ));
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (!threads) throw new Error(`Pull request #${input.target.number} is unavailable`);
    thread = threads.nodes.find((candidate) => candidate.comments.nodes[0]?.databaseId === rootId);
    after = !thread && threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (after);
  if (!thread) throw notOnPullRequest;

  await githubGraphql(
    dependencies.fetch,
    token,
    `mutation ResponderReplyToReviewThread($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
        comment { id }
      }
    }`,
    { body: input.body, threadId: thread.id },
  );
  if (!input.resolve || thread.isResolved) return { resolved: thread.isResolved };
  try {
    await githubGraphql(
      dependencies.fetch,
      token,
      `mutation ResponderResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
      }`,
      { threadId: thread.id },
    );
    return { resolved: true };
  } catch (error) {
    return {
      resolveError: error instanceof Error ? error.message : "Unable to resolve the thread",
      resolved: false,
    };
  }
}
