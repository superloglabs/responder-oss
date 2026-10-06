import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "@responder/core/integrations/github";
import {
  countBotReviewTurn,
  findPullRequestReviewTarget,
  maxBotReviewTurns,
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
  countBotReviewTurn: typeof countBotReviewTurn;
  findTarget: typeof findPullRequestReviewTarget;
  listComments: (event: PullRequestReviewEvent) => Promise<PullRequestReviewComment[]>;
  queueAutomationRunReply: typeof queueAutomationRunReply;
  queueThreadTurn: typeof queueSlackThreadInvestigation;
}

const defaultDependencies: ReviewTurnDependencies = {
  countBotReviewTurn,
  findTarget: findPullRequestReviewTarget,
  listComments: listReviewComments,
  queueAutomationRunReply,
  queueThreadTurn: queueSlackThreadInvestigation,
};

// More comments than fit in one message are left out; the message says so.
const maxReviewCommentPages = 5;

export async function listReviewComments(
  event: PullRequestReviewEvent,
  fetchImpl: typeof fetch = fetch,
  createToken: typeof createGitHubInstallationToken = createGitHubInstallationToken,
): Promise<PullRequestReviewComment[]> {
  const token = await createToken(event.installation.id, AbortSignal.timeout(10_000));
  const comments: PullRequestReviewComment[] = [];
  let url: string | null =
    `https://api.github.com/repos/${event.repository.full_name}/pulls/${event.pull_request.number}/reviews/${event.review.id}/comments?per_page=100`;
  for (let page = 0; url && page < maxReviewCommentPages; page += 1) {
    const response: Response = await fetchImpl(url, {
      headers: githubAppHeaders(token),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Unable to read the review's comments (${response.status})`);
    }
    comments.push(...reviewCommentsSchema.parse(await response.json()));
    url = /<([^>]+)>;\s*rel="next"/u.exec(response.headers.get("link") ?? "")?.[1] ?? null;
  }
  return comments;
}

const maxCommentLength = 4_000;
const messageLimit = automationUserMessageMaxLength - 100;

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
  const lines = [
    `${reviewer.login}${reviewer.type === "Bot" ? " (a bot)" : ""} reviewed pull request #${event.pull_request.number} in ${event.repository.full_name}, which you opened: ${event.review.html_url}`,
    ...(body ? ["", "Review:", clip(body, maxCommentLength)] : []),
  ];
  if (comments.length > 0) lines.push("", "Comments:");
  let length = lines.join("\n").length;
  // Whole comments only, so every listed ID is complete. The rest are on
  // the review page.
  for (const [index, comment] of comments.entries()) {
    const line = comment.line ?? comment.original_line;
    const entry = [
      `- Comment ${comment.id}${comment.in_reply_to_id ? ` (a reply to comment ${comment.in_reply_to_id})` : ""} on ${comment.path}${line ? ` line ${line}` : ""}:`,
      clip(comment.body.trim(), maxCommentLength),
    ].join("\n");
    if (length + entry.length + 200 > messageLimit) {
      lines.push(`${comments.length - index} more comments did not fit. Read them on the review page.`);
      break;
    }
    lines.push(entry);
    length += entry.length + 1;
  }
  return lines.join("\n");
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

  if (bot && target.botReviewTurns >= maxBotReviewTurns) return "bot_limit_reached";
  const comments = await dependencies.listComments(event);
  if (!event.review.body?.trim() && comments.length === 0) return "ignored";

  const outcome = await queueReviewTurn(target, event, pullRequestReviewMessage(event, comments), dependencies);
  // A redelivered review is a duplicate and does not use up a bot turn.
  if (bot && (outcome === "queued" || outcome === "waiting")) {
    await dependencies.countBotReviewTurn(target.id);
  }
  return outcome;
}

async function queueReviewTurn(
  target: PullRequestReviewTarget,
  event: PullRequestReviewEvent,
  text: string,
  dependencies: ReviewTurnDependencies,
): Promise<PullRequestReviewOutcome> {
  const reviewer = event.review.user!;
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
