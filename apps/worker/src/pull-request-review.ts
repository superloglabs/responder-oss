import {
  createGitHubInstallationToken,
} from "@responder/core/integrations/github";
import { z } from "zod";
import { githubJson, repositoryApiPath } from "./github-pull-request.js";
import type { PullRequestTarget } from "./pull-request-follow-up.js";
import { assertNoDaytonaSecretPlaceholders } from "./secret-safety.js";

// Posts a review on the pull request that started an automation run. The
// review only comments: it never approves or requests changes.

export interface PullRequestReviewComment {
  body: string;
  line: number;
  path: string;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
}

export interface PullRequestReviewDependencies {
  createInstallationToken: (installationId: number) => Promise<string>;
  fetch: typeof fetch;
}

const defaultDependencies: PullRequestReviewDependencies = {
  createInstallationToken: createGitHubInstallationToken,
  fetch,
};

const reviewSchema = z.object({
  html_url: z.string().url(),
  id: z.number().int(),
});

export async function reviewPullRequest(
  input: {
    body: string;
    comments: PullRequestReviewComment[];
    // The head commit the agent read. Without it, GitHub places the comments
    // on the latest commit, which may have changed since.
    commitSha?: string;
    target: PullRequestTarget;
  },
  dependencies: PullRequestReviewDependencies = defaultDependencies,
): Promise<{ comments: number; reviewId: number; url: string }> {
  assertNoDaytonaSecretPlaceholders(
    [input.body, ...input.comments.flatMap((comment) => [comment.body, comment.path])],
    "Pull request review",
  );
  const token = await dependencies.createInstallationToken(input.target.installationId);
  const review = reviewSchema.parse(await githubJson(
    dependencies.fetch,
    token,
    `https://api.github.com/repos/${repositoryApiPath(input.target.repository)}/pulls/${input.target.number}/reviews`,
    {
      body: JSON.stringify({
        body: input.body,
        comments: input.comments.map((comment) => ({
          body: comment.body,
          line: comment.line,
          path: comment.path,
          side: comment.side ?? "RIGHT",
          ...(comment.startLine === undefined
            ? {}
            : { start_line: comment.startLine, start_side: comment.side ?? "RIGHT" }),
        })),
        ...(input.commitSha ? { commit_id: input.commitSha } : {}),
        event: "COMMENT",
      }),
      method: "POST",
    },
  ));
  return { comments: input.comments.length, reviewId: review.id, url: review.html_url };
}
