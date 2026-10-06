import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "@responder/core/integrations/github";
import {
  admitBotReviewTurn,
  findPullRequestReviewTarget,
  type PullRequestReviewTarget,
} from "@responder/core/db/pull-request-origins";
import { automationUserMessageMaxLength } from "@responder/core/automations/transcript";
import type { InvestigationRequest } from "@responder/core/investigations/input";
import { z } from "zod";
import { queueAutomationRunReply } from "../automations/queue.js";
import { queueSlackThreadInvestigation } from "../investigations/queue.js";

export const pullRequestReviewEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
  pull_request: z.object({
    html_url: z.string().url(),
    number: z.number().int().positive(),
  }),
  repository: z.object({ full_name: z.string().min(1) }),
  review: z.object({
    author_association: z.string(),
    body: z.string().max(65_536).nullable(),
    html_url: z.string().url(),
    id: z.number().int().positive(),
    state: z.string(),
    user: z.object({ login: z.string().min(1), type: z.string() }).nullable(),
  }),
});

export type PullRequestReviewEvent = z.infer<typeof pullRequestReviewEventSchema>;

const reviewCommentsSchema = z.array(z.object({
  body: z.string(),
  html_url: z.string().url(),
  id: z.number().int().positive(),
  in_reply_to_id: z.number().int().positive().optional(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  path: z.string(),
}));

export type PullRequestReviewComment = z.infer<typeof reviewCommentsSchema>[number];

// People who can push to the repository. Anyone can review a public
// repository, and their text must not steer the agent.
const trustedAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

export type PullRequestReviewOutcome =
  | "ignored"
  | "not_ours"
  | "bot_limit_reached"
  | "duplicate"
  | "blocked"
  | "queued"
  | "waiting";

interface ReviewTurnDependencies {
  admitBotReviewTurn: typeof admitBotReviewTurn;
  findTarget: typeof findPullRequestReviewTarget;
  listComments: (event: PullRequestReviewEvent) => Promise<PullRequestReviewComment[]>;
  queueAutomationRunReply: typeof queueAutomationRunReply;
  queueThreadTurn: typeof queueSlackThreadInvestigation;
}

const defaultDependencies: ReviewTurnDependencies = {
  admitBotReviewTurn,
  findTarget: findPullRequestReviewTarget,
  listComments: listReviewComments,
  queueAutomationRunReply,
  queueThreadTurn: queueSlackThreadInvestigation,
};

async function listReviewComments(
  event: PullRequestReviewEvent,
): Promise<PullRequestReviewComment[]> {
  const token = await createGitHubInstallationToken(
    event.installation.id,
    AbortSignal.timeout(10_000),
  );
  const response = await fetch(
    `https://api.github.com/repos/${event.repository.full_name}/pulls/${event.pull_request.number}/reviews/${event.review.id}/comments?per_page=100`,
    { headers: githubAppHeaders(token), signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) {
    throw new Error(`Unable to read the review's comments (${response.status})`);
  }
  return reviewCommentsSchema.parse(await response.json());
}

const maxCommentLength = 4_000;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

// The review as one message. Comment IDs let the agent reply to each one.
export function pullRequestReviewMessage(
  event: PullRequestReviewEvent,
  comments: PullRequestReviewComment[],
): string {
  const reviewer = event.review.user!;
  const body = event.review.body?.trim();
  const message = [
    `${reviewer.login}${reviewer.type === "Bot" ? " (a bot)" : ""} reviewed pull request #${event.pull_request.number} in ${event.repository.full_name}, which you opened: ${event.review.html_url}`,
    ...(body ? ["", "Review:", clip(body, maxCommentLength)] : []),
    ...(comments.length > 0
      ? [
          "",
          "Comments:",
          ...comments.map((comment) => {
            const line = comment.line ?? comment.original_line;
            return [
              `- Comment ${comment.id}${comment.in_reply_to_id ? ` (a reply to comment ${comment.in_reply_to_id})` : ""} on ${comment.path}${line ? ` line ${line}` : ""}:`,
              clip(comment.body.trim(), maxCommentLength),
            ].join("\n");
          }),
        ]
      : []),
  ].join("\n");
  return clip(message, automationUserMessageMaxLength - 100);
}

// Where the thread answers. Values about the earlier message, such as its
// author, are left out.
const threadAttributes = [
  "channelId",
  "integrationAccountId",
  "linearAgentSessionId",
  "linearIssueId",
  "linearIssueIdentifier",
  "slackAssistant",
  "teamId",
  "threadTimestamp",
];

function threadTurnRequest(
  thread: NonNullable<PullRequestReviewTarget["thread"]>,
  event: PullRequestReviewEvent,
  text: string,
): InvestigationRequest | null {
  const latest = thread.latestInput;
  if (latest?.provider !== "slack" && latest?.provider !== "linear") return null;
  const attributes = Object.fromEntries(
    Object.entries(latest.attributes ?? {}).filter(([name]) => threadAttributes.includes(name)),
  );
  return {
    agentId: thread.agentId,
    attributes: {
      ...attributes,
      ...(latest.provider === "slack" ? { timestamp: thread.threadTimestamp } : {}),
      githubPullRequestNumber: event.pull_request.number,
      githubRepository: event.repository.full_name,
      githubReviewUrl: event.review.html_url,
    },
    body: text,
    externalEventId: `github-review:${event.review.id}`,
    provider: latest.provider,
    sourceUrl: event.review.html_url,
    title: `Review on ${event.repository.full_name}#${event.pull_request.number}`,
  };
}

// A submitted review on a pull request a tag mode thread or an automation run
// opened continues that thread or run. GitHub sends one event per review,
// with all of its inline comments, including a reviewer bot's batch.
export async function startPullRequestReviewTurn(
  event: PullRequestReviewEvent,
  dependencies: ReviewTurnDependencies = defaultDependencies,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PullRequestReviewOutcome> {
  const reviewer = event.review.user;
  if (event.action !== "submitted" || !reviewer) return "ignored";
  // The app's own replies arrive as reviews too.
  if (environment.GITHUB_APP_SLUG && reviewer.login === `${environment.GITHUB_APP_SLUG}[bot]`) {
    return "ignored";
  }
  const bot = reviewer.type === "Bot";
  if (!bot && !trustedAssociations.has(event.review.author_association)) {
    return "ignored";
  }

  const target = await dependencies.findTarget({
    pullRequestNumber: event.pull_request.number,
    repositoryFullName: event.repository.full_name,
  });
  if (!target) return "not_ours";
  if (target.automationRun && !target.automationRun.automationEnabled) return "ignored";

  const comments = await dependencies.listComments(event);
  if (!event.review.body?.trim() && comments.length === 0) return "ignored";
  if (bot && !(await dependencies.admitBotReviewTurn(target.id))) {
    return "bot_limit_reached";
  }

  const text = pullRequestReviewMessage(event, comments);
  if (target.automationRun) {
    return dependencies.queueAutomationRunReply({
      message: {
        authorId: reviewer.login,
        authorName: reviewer.login,
        externalEventId: `github-review:${event.review.id}`,
        githubReview: {
          pullRequestNumber: event.pull_request.number,
          repository: event.repository.full_name,
          reviewUrl: event.review.html_url,
        },
        source: "github",
        text,
      },
      runId: target.automationRun.id,
    });
  }
  if (!target.thread) return "ignored";
  const request = threadTurnRequest(target.thread, event, text);
  if (!request) return "ignored";
  const result = await dependencies.queueThreadTurn(request, {
    channelId: target.thread.channelId,
    teamId: target.thread.teamId,
    threadTimestamp: target.thread.threadTimestamp,
  });
  return result.kind;
}
