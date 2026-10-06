import { createHash } from "node:crypto";
import { tool } from "@openai/agents";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { getRuntimeRepositories } from "@responder/core/db/investigations";
import {
  getOwnedPullRequest,
  recordPullRequestOrigin,
} from "@responder/core/db/pull-request-origins";
import { z } from "zod";
import { createPullRequestFromSandbox } from "./github-pull-request.js";
import {
  checkoutPullRequest,
  replyToPullRequestComment,
  updatePullRequest,
} from "./pull-request-follow-up.js";
import {
  checkoutRuntimeRepositoryAtRef,
  type CheckedOutRepository,
} from "./repositories.js";

export const threadPullRequestToolName = "open_pull_request";

interface ThreadPullRequestDependencies {
  captureEvent: typeof captureAnalyticsEvent;
  createPullRequest: typeof createPullRequestFromSandbox;
  getRepositories: typeof getRuntimeRepositories;
  recordOrigin: typeof recordPullRequestOrigin;
}

const defaultDependencies: ThreadPullRequestDependencies = {
  captureEvent: captureAnalyticsEvent,
  createPullRequest: createPullRequestFromSandbox,
  getRepositories: getRuntimeRepositories,
  recordOrigin: recordPullRequestOrigin,
};

// The branch suffix is derived from the turn, repository, and title, so the
// same request opens the same branch name.
function requestId(investigationId: string, repository: string, title: string): string {
  return createHash("sha256")
    .update(`${investigationId}\0${repository}\0${title}`, "utf8")
    .digest("hex");
}

// Lets a Slack thread publish its checkout changes as a pull request. Only
// repositories selected for tag mode can be targeted. A call repeated with
// the same repository and title in one turn returns the pull request it
// already opened.
export function createThreadPullRequestTool(input: {
  agentConfigVersionId: string;
  investigationId: string;
  organizationId: string;
  repositories: CheckedOutRepository[];
  session: DaytonaSandboxSession;
  slackInvestigationSessionId: string;
}, dependencies: ThreadPullRequestDependencies = defaultDependencies) {
  const repositoryNames = [
    ...new Set(input.repositories.map(({ repository }) => repository)),
  ];
  if (repositoryNames.length === 0) {
    throw new Error("No repositories are checked out for this thread");
  }
  const opened = new Map<string, Awaited<ReturnType<typeof createPullRequestFromSandbox>>>();
  // A review on the pull request continues this thread. Recording is safe to
  // repeat, so a failed write is retried when the agent calls again.
  const recordOrigin = async (repository: string, pullRequestNumber: number) => {
    try {
      await dependencies.recordOrigin({
        organizationId: input.organizationId,
        pullRequestNumber,
        repositoryFullName: repository,
        slackInvestigationSessionId: input.slackInvestigationSessionId,
      });
      return {};
    } catch {
      return {
        warning: `Reviews of this pull request cannot reach this thread yet. Call ${threadPullRequestToolName} again with the same repository and title to retry.`,
      };
    }
  };
  return tool({
    name: threadPullRequestToolName,
    description:
      "Open a GitHub pull request with the current changes in a checked-out repository's working tree, against the branch it was checked out from. Make and test the changes first. Returns the pull request URL.",
    parameters: z.object({
      body: z.string().trim().min(1).max(12_000)
        .describe("The Markdown pull request body, following any repository template."),
      repository: z.enum(repositoryNames as [string, ...string[]])
        .describe(`One of: ${repositoryNames.join(", ")}`),
      title: z.string().trim().min(1).max(240),
    }),
    async execute(request) {
      const key = `${request.repository}\0${request.title}`;
      const existing = opened.get(key);
      if (existing) {
        return {
          note: "This pull request was already opened.",
          number: existing.number,
          url: existing.url,
          ...await recordOrigin(request.repository, existing.number),
        };
      }
      const checkout = input.repositories.find(
        (candidate) => candidate.repository === request.repository,
      );
      const repository = (await dependencies.getRepositories(input.agentConfigVersionId))
        .find((candidate) => candidate.fullName === request.repository);
      if (!checkout || !repository) {
        throw new Error("The repository is not selected for tag mode");
      }
      const pullRequest = await dependencies.createPullRequest({
        baseBranch: checkout.branch,
        baseSha: checkout.sha,
        body: request.body,
        installationId: repository.installationId,
        repository: repository.fullName,
        repositoryPath: checkout.path,
        requestId: requestId(input.investigationId, request.repository, request.title),
        title: request.title,
        workspaceBaseSha: checkout.workspaceBaseSha,
      }, input.session);
      opened.set(key, pullRequest);
      const origin = await recordOrigin(repository.fullName, pullRequest.number);
      await dependencies.captureEvent({
        distinctId: `investigation:${input.investigationId}`,
        event: "pr opened",
        organizationId: input.organizationId,
        properties: {
          $process_person_profile: false,
          agent_config_version_id: input.agentConfigVersionId,
          investigation_id: input.investigationId,
          pr_number: pullRequest.number,
          pr_url: pullRequest.url,
          repository: repository.fullName,
          slack_thread_mode: true,
        },
      }).catch(() => undefined);
      return {
        branch: pullRequest.branch,
        changedFiles: pullRequest.changedFiles,
        number: pullRequest.number,
        url: pullRequest.url,
        ...origin,
      };
    },
  });
}

interface ThreadPullRequestFollowUpDependencies {
  checkoutAtRef: typeof checkoutRuntimeRepositoryAtRef;
  checkoutPullRequest: typeof checkoutPullRequest;
  getOwnedPullRequest: typeof getOwnedPullRequest;
  getRepositories: typeof getRuntimeRepositories;
  replyToComment: typeof replyToPullRequestComment;
  updatePullRequest: typeof updatePullRequest;
}

const defaultFollowUpDependencies: ThreadPullRequestFollowUpDependencies = {
  checkoutAtRef: checkoutRuntimeRepositoryAtRef,
  checkoutPullRequest,
  getOwnedPullRequest,
  getRepositories: getRuntimeRepositories,
  replyToComment: replyToPullRequestComment,
  updatePullRequest,
};

// Lets a thread keep working on pull requests it opened: check one out, push
// more commits to it, and answer its review comments.
export function createThreadPullRequestFollowUpTools(input: {
  agentConfigVersionId: string;
  repositories: CheckedOutRepository[];
  session: DaytonaSandboxSession;
  slackInvestigationSessionId: string;
}, dependencies: ThreadPullRequestFollowUpDependencies = defaultFollowUpDependencies) {
  const pullRequestParameters = {
    pullRequestNumber: z.number().int().positive(),
    repository: z.string().trim().min(1).max(255).describe("The repository, as owner/name."),
  };
  const target = async (request: { pullRequestNumber: number; repository: string }) => {
    const owned = await dependencies.getOwnedPullRequest({
      pullRequestNumber: request.pullRequestNumber,
      repositoryFullName: request.repository,
      slackInvestigationSessionId: input.slackInvestigationSessionId,
    });
    if (!owned) throw new Error("This thread did not open that pull request");
    const repository = (await dependencies.getRepositories(input.agentConfigVersionId))
      .find((candidate) => candidate.fullName === request.repository);
    if (!repository) throw new Error("The repository is not selected for tag mode");
    return {
      installationId: repository.installationId,
      number: request.pullRequestNumber,
      repository: request.repository,
    };
  };
  const checkout = async (request: { pullRequestNumber: number; repository: string }) => {
    const pullRequest = await target(request);
    return dependencies.checkoutPullRequest({
      checkoutAtRef: (reference) => dependencies.checkoutAtRef(
        input.session,
        input.agentConfigVersionId,
        pullRequest.repository,
        reference,
      ),
      repositories: input.repositories,
      session: input.session,
      target: pullRequest,
    });
  };
  const tools = [
    tool({
      name: "checkout_pull_request",
      description:
        "Replace a repository's checkout with the latest commit of a pull request this thread opened, so you can change it. The old checkout's changes are saved as a patch file whose path is returned as savedChanges; they may include changes already in a pull request. Does nothing when the checkout is already at that commit.",
      parameters: z.object(pullRequestParameters),
      async execute(request) {
        const result = await checkout(request);
        return {
          branch: result.head.branch,
          headSha: result.head.sha,
          path: result.checkout.path,
          replaced: result.replaced,
          ...(result.savedChanges ? { savedChanges: result.savedChanges } : {}),
        };
      },
    }),
    tool({
      name: "update_pull_request",
      description:
        "Push the checkout's changes as one commit to a pull request this thread opened. The checkout must be at the pull request's latest commit: call checkout_pull_request before making the changes. Make and test the changes first.",
      parameters: z.object({
        ...pullRequestParameters,
        commitMessage: z.string().trim().min(1).max(240),
      }),
      async execute(request) {
        return dependencies.updatePullRequest({
          commitMessage: request.commitMessage,
          repositories: input.repositories,
          session: input.session,
          target: await target(request),
        });
      },
    }),
    tool({
      name: "reply_to_pull_request_comment",
      description:
        "Reply to a review comment on a pull request this thread opened, in the comment's thread. Set resolve when the comment is addressed or needs no change.",
      parameters: z.object({
        ...pullRequestParameters,
        body: z.string().trim().min(1).max(4_000),
        commentId: z.number().int().positive(),
        resolve: z.boolean(),
      }),
      async execute(request) {
        return dependencies.replyToComment({
          body: request.body,
          commentId: request.commentId,
          resolve: request.resolve,
          target: await target(request),
        });
      },
    }),
  ];
  return { checkout, tools };
}

// The pull request a review turn is about, from the turn's request.
export function pullRequestReviewOf(
  attributes: Record<string, string | number | boolean | null> | undefined,
): { pullRequestNumber: number; repository: string } | null {
  const repository = attributes?.githubRepository;
  const pullRequestNumber = attributes?.githubPullRequestNumber;
  return typeof repository === "string" &&
      typeof pullRequestNumber === "number" &&
      Number.isInteger(pullRequestNumber) &&
      pullRequestNumber > 0
    ? { pullRequestNumber, repository }
    : null;
}
