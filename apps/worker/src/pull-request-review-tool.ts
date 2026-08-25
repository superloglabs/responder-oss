import { tool } from "@openai/agents";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { z } from "zod";
import type {
  BotReviewThread,
  PullRequestReviewState,
} from "./github-pull-request-review.js";
import {
  assertPullRequestReviewStateCurrent,
  listUnresolvedBotReviewThreads,
  publishPullRequestReviewChanges,
  replyToAndResolveReviewThreads,
} from "./github-pull-request-review.js";
import type { CheckedOutRepository } from "./repositories.js";

export interface AddressedReviewResult {
  addressedThreadIds: string[];
  changedFiles: string[];
  commitMessage: string;
  headSha: string;
  responses: Array<{ body: string; threadId: string }>;
}

export function createPullRequestReviewTool(input: {
  checkout: CheckedOutRepository;
  installationId: number;
  pullRequestNumber: number;
  review: PullRequestReviewState;
  session: DaytonaSandboxSession;
  threads: BotReviewThread[];
}) {
  let result: AddressedReviewResult | undefined;
  const allowedThreadIds = new Set(input.threads.map((thread) => thread.id));

  return {
    getResult: () => result,
    tool: tool({
      name: "address_pull_request_reviews",
      description:
        "Publish the current follow-up changes, reply to every supplied review thread, and resolve those threads. Call exactly once after validating every bot comment and running focused checks. Explain politely when a comment needs no code change.",
      parameters: z.object({
        commitMessage: z.string().trim().min(1).max(240),
        responses: z
          .array(
            z.object({
              body: z.string().trim().min(1).max(4_000),
              threadId: z.string().min(1),
            }),
          )
          .min(1),
      }),
      async execute(request) {
        if (result) throw new Error("Review threads were already addressed");
        const responseIds = request.responses.map((response) => response.threadId);
        if (
          new Set(responseIds).size !== responseIds.length ||
          responseIds.some((threadId) => !allowedThreadIds.has(threadId)) ||
          responseIds.length !== allowedThreadIds.size
        ) {
          throw new Error("Responses must cover every supplied review thread exactly once");
        }

        const currentReview = await listUnresolvedBotReviewThreads({
          installationId: input.installationId,
          pullRequestNumber: input.pullRequestNumber,
          repository: input.checkout.repository,
        });
        assertPullRequestReviewStateCurrent(
          input.review,
          currentReview,
          allowedThreadIds,
        );

        const published = await publishPullRequestReviewChanges(
          {
            branch: input.review.branch,
            commitMessage: request.commitMessage,
            headSha: input.review.headSha,
            installationId: input.installationId,
            repository: input.checkout.repository,
            repositoryPath: input.checkout.path,
            workspaceBaseSha: input.checkout.workspaceBaseSha,
          },
          input.session,
        );
        await replyToAndResolveReviewThreads({
          installationId: input.installationId,
          responses: request.responses,
        });
        result = {
          addressedThreadIds: responseIds,
          changedFiles: published.changedFiles,
          commitMessage: request.commitMessage,
          headSha: published.headSha,
          responses: request.responses,
        };
        return result;
      },
    }),
  };
}
