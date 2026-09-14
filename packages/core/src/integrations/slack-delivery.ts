import { createHash } from "node:crypto";
import { z } from "zod";
import { decryptCredentials } from "../credentials/encryption.js";
import { responderIssueUrl } from "../responder-urls.js";
import {
  getIssueForSlackBackfill,
  getSlackInvestigationDeliveryContext,
  getSlackInvestigationLiveContext,
  type SlackInvestigationDeliveryContext,
} from "../db/issues.js";
import {
  recordInvestigationSlackReply,
  getSlackInvestigationThreadLinks,
  recordSlackInvestigationThreadLink,
  setInvestigationSlackReaction,
} from "../db/investigations.js";
import { registerIssuePullRequestSlackMessage } from "../db/pull-requests.js";
import {
  addSlackReaction,
  postSlackMessage,
  removeSlackReaction,
  setSlackThreadStatus,
  stopSlackResponseStream,
  updateSlackMessage,
} from "./slack.js";
import {
  refreshIssuePullRequestSlackMessages,
  slackIssuePullRequestMessage,
  slackRemediationCarousel,
} from "./slack-remediations.js";
import {
  slackErrorLogFields,
  slackInvestigationFeedbackBlock,
  slackInvestigationCard,
} from "./slack-live-card.js";

const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});

type DeliveryIssue = SlackInvestigationDeliveryContext["issues"][number];

export function slackNoIssueThreadLink(
  context: SlackInvestigationDeliveryContext,
  messageTimestamp: string,
) {
  if (
    context.issues.length > 0 ||
    !context.source?.teamId ||
    !context.organizationId
  ) {
    return null;
  }
  return {
    channelId: context.source.channelId,
    integrationAccountId: context.source.integrationAccountId,
    investigationId: context.investigationId,
    issueId: null,
    messageTimestamp,
    organizationId: context.organizationId,
    teamId: context.source.teamId,
    threadTimestamp: context.source.threadTimestamp,
  };
}

export function slackDeliveryClientMessageId(
  deliveryRunId: string,
  deliveryKey: string,
): string {
  const bytes = createHash("sha256")
    .update(`${deliveryRunId}:${deliveryKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function filterSlackOutputIssues(
  issues: DeliveryIssue[],
  severities: Array<"SEV-1" | "SEV-2" | "SEV-3"> | null,
): DeliveryIssue[] {
  return severities
    ? issues.filter((issue) => severities.includes(issue.severity))
    : issues;
}

export function slackCompletionReaction(
  issues: DeliveryIssue[],
): "large_red_square" | "large_orange_square" | "large_yellow_square" | "white_check_mark" {
  if (issues.some((issue) => issue.severity === "SEV-1")) {
    return "large_red_square";
  }
  if (issues.some((issue) => issue.severity === "SEV-2")) {
    return "large_orange_square";
  }
  if (issues.some((issue) => issue.severity === "SEV-3")) {
    return "large_yellow_square";
  }
  return "white_check_mark";
}

export function slackThreadCompletionText(
  summary: string,
  issueCount: number,
): string {
  if (issueCount === 0) {
    return `✅ *No issues identified.* ${summary}`;
  }
  return `*${issueCount} ${issueCount === 1 ? "issue" : "issues"} identified:*`;
}

export function slackInvestigationSummaryMessage(input: {
  issueCount: number;
  summary: string;
}): { blocks: unknown[]; text: string } {
  const text = slackThreadCompletionText(input.summary, input.issueCount);
  return {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
    ],
  };
}

function escapeSlack(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncateSlackBlock(value: string, maxLength = 2_900): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 1).trimEnd()}…`
    : value;
}

function responderAppUrl(): string {
  return (
    process.env.RESPONDER_APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

export function slackIssueMessage(
  issue: DeliveryIssue,
  investigationId: string,
  canCreatePullRequest = false,
): { blocks: unknown[]; text: string } {
  const recurrence = issue.relationship === "recurrence" ? " · Recurrence" : "";
  const text = [
    `${issue.severity} — ${issue.title}${recurrence}`,
    issue.description,
  ].filter((value): value is string => Boolean(value)).join("\n\n");
  const issueUrl = responderIssueUrl(issue.id, responderAppUrl());
  const blockText = truncateSlackBlock(
    [
      `*${issue.severity} — ${escapeSlack(issue.title)}*${recurrence}`,
      escapeSlack(issue.description),
    ].filter((value): value is string => Boolean(value)).join("\n\n"),
  );
  return {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: blockText },
      },
      ...(issue.remediations.length > 0
        ? slackRemediationCarousel({
            canCreatePullRequest,
            issueId: issue.id,
            remediations: issue.remediations,
          })
        : []),
      {
        type: "actions",
        block_id: `issue_actions_${issue.id}`,
        elements: [
          {
            type: "button",
            action_id: "view_issue",
            text: { type: "plain_text", text: "View issue" },
            url: issueUrl,
            value: issue.id,
          },
        ],
      },
      slackInvestigationFeedbackBlock(investigationId),
    ],
  };
}

function issueSlackMessage(
  context: SlackInvestigationDeliveryContext,
  issue: DeliveryIssue,
) {
  const request = issue.pullRequest;
  const selectedRemediation = request?.remediationId
    ? issue.remediations.find(
        (remediation) => remediation.id === request.remediationId,
      )
    : undefined;
  return context.prMode === "always" && request && selectedRemediation
    ? slackIssuePullRequestMessage({
        failureReason: request.failureReason,
        issueId: issue.id,
        issueSeverity: issue.severity,
        issueTitle: issue.title,
        pullRequestNumber: request.pullRequestNumber,
        pullRequestUrl: request.pullRequestUrl,
        repositoryFullName: request.repositoryFullName,
        requestId: request.id,
        selectedRemediation,
        status: request.status,
      }, context.investigationId)
    : slackIssueMessage(
        issue,
        context.investigationId,
        canCreateIssuePullRequest(context, issue),
      );
}

function canCreateIssuePullRequest(
  context: SlackInvestigationDeliveryContext,
  issue: DeliveryIssue,
): boolean {
  return context.prMode === "manual" &&
    issue.remediations.some((remediation) => remediation.type === "code_change");
}

export function slackIssueFollowupMessage(input: {
  context: SlackInvestigationDeliveryContext | null;
  response: string;
  updatedIssueIds: string[];
}): { blocks: unknown[]; text: string } {
  const issues = input.context?.issues.filter((issue) =>
    input.updatedIssueIds.includes(issue.id)
  ) ?? [];
  const remediationText = issues.length > 0
    ? issues.map((issue) =>
      `Updated remediation — ${issue.title}\n${issue.remediation}`
    ).join("\n\n")
    : "No issue remediation was changed; the investigation needs clarification before making a safe update.";
  const text = `${input.response}\n\n${remediationText}`.slice(0, 100_000);
  const blocks: unknown[] = [{
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncateSlackBlock(input.response),
    },
  }];

  if (issues.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: remediationText },
    });
  } else {
    for (const issue of issues) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Updated remediation — ${escapeSlack(issue.title)}*`,
        },
      });
      blocks.push(...slackRemediationCarousel({
        canCreatePullRequest: input.context
          ? canCreateIssuePullRequest(input.context, issue)
          : false,
        issueId: issue.id,
        remediations: issue.remediations,
      }));
    }
  }

  return { blocks, text };
}

async function registerPullRequestMessage(input: {
  channelId: string;
  integrationAccountId: string;
  issue: DeliveryIssue;
  messageTimestamp: string | null;
}): Promise<void> {
  if (!input.issue.pullRequest || !input.messageTimestamp) return;
  await registerIssuePullRequestSlackMessage({
    channelId: input.channelId,
    integrationAccountId: input.integrationAccountId,
    messageTimestamp: input.messageTimestamp,
    requestId: input.issue.pullRequest.id,
  });
  await refreshIssuePullRequestSlackMessages(input.issue.pullRequest.id);
}

function accessToken(encryptedCredentials: string): string {
  return slackCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(encryptedCredentials),
  ).accessToken;
}

interface SlackIssueRedeliveryDependencies {
  getContext: typeof getSlackInvestigationDeliveryContext;
  getDetachedIssue: typeof getIssueForSlackBackfill;
  postMessage: typeof postSlackMessage;
  recordReply: typeof recordInvestigationSlackReply;
  registerPullRequestMessage: typeof registerPullRequestMessage;
  resolveAccessToken: typeof accessToken;
}

export async function redeliverInvestigationSlackIssue(
  input: {
    allowDetachedIssue?: boolean;
    deliveryRunId: string;
    investigationId: string;
    issueId: string;
  },
  dependencies?: SlackIssueRedeliveryDependencies,
): Promise<{ issueId: string; messageTimestamp: string }> {
  const resolvedDependencies = dependencies ?? {
    getContext: getSlackInvestigationDeliveryContext,
    getDetachedIssue: getIssueForSlackBackfill,
    postMessage: postSlackMessage,
    recordReply: recordInvestigationSlackReply,
    registerPullRequestMessage,
    resolveAccessToken: accessToken,
  };
  const context = await resolvedDependencies.getContext(input.investigationId);
  if (!context?.source) {
    throw new Error(
      `Slack source thread is unavailable for investigation ${input.investigationId}`,
    );
  }
  const issue = context.issues.find((candidate) => candidate.id === input.issueId) ??
    (input.allowDetachedIssue
      ? await resolvedDependencies.getDetachedIssue({
          investigationId: input.investigationId,
          issueId: input.issueId,
        })
      : null);
  if (!issue) {
    throw new Error(
      `Issue ${input.issueId} is not available for investigation ${input.investigationId}`,
    );
  }
  const message = issueSlackMessage(context, issue);
  const messageTimestamp = await resolvedDependencies.postMessage({
    accessToken: resolvedDependencies.resolveAccessToken(
      context.source.encryptedCredentials,
    ),
    blocks: message.blocks,
    channelId: context.source.channelId,
    clientMessageId: slackDeliveryClientMessageId(
      input.deliveryRunId,
      `source:${context.source.channelId}:issue:${issue.id}`,
    ),
    text: message.text,
    threadTimestamp: context.source.threadTimestamp,
  });
  if (!messageTimestamp) {
    throw new Error(
      `Slack did not return a message timestamp for issue ${input.issueId}`,
    );
  }
  await resolvedDependencies.recordReply(input.investigationId, {
    attachments: [],
    authorName: "Responder",
    blocks: message.blocks,
    key: `issue:${issue.id}`,
    slackTimestamp: messageTimestamp,
    text: message.text,
  });
  await resolvedDependencies.registerPullRequestMessage({
    channelId: context.source.channelId,
    integrationAccountId: context.source.integrationAccountId,
    issue,
    messageTimestamp,
  });
  return { issueId: issue.id, messageTimestamp };
}

export function slackCompletedInvestigationCard(
  context: Pick<
    SlackInvestigationDeliveryContext,
    | "agentId"
    | "executionMode"
    | "investigationId"
    | "organizationId"
    | "title"
    | "traceItems"
  >,
) {
  return slackInvestigationCard({
    agentId: context.agentId,
    detail: "Completed the investigation plan.",
    investigationId: context.investigationId,
    organizationId: context.organizationId,
    showInvestigationLink: context.executionMode !== "slack_thread",
    status: "complete",
    title: context.title,
    traceItems: context.traceItems ?? [],
  });
}

export async function deliverSlackThreadInvestigationResponse(input: {
  deliveryRunId: string;
  investigationId: string;
  response: string;
}): Promise<void> {
  const context = await getSlackInvestigationLiveContext(input.investigationId);
  if (!context) {
    throw new Error("Slack thread context is unavailable");
  }
  const token = accessToken(context.source.encryptedCredentials);
  const markdown = input.response.slice(0, 11_900);
  const message = {
    text: markdown,
    blocks: [{ type: "markdown", text: markdown }],
  };
  const messageTimestamp = context.source.responseMessageTimestamp
    ? context.source.responseMessageTimestamp
    : await postSlackMessage({
        accessToken: token,
        blocks: message.blocks,
        channelId: context.source.channelId,
        clientMessageId: slackDeliveryClientMessageId(
          input.deliveryRunId,
          `thread-response:${input.investigationId}`,
        ),
        text: message.text,
        threadTimestamp: context.source.threadTimestamp,
      });
  if (!messageTimestamp) {
    throw new Error("Slack did not return a response message timestamp");
  }
  if (context.source.responseMessageTimestamp) {
    await stopSlackResponseStream({
      accessToken: token,
      channelId: context.source.channelId,
      markdownText: markdown,
      timestamp: context.source.responseMessageTimestamp,
    });
  }
  await recordInvestigationSlackReply(input.investigationId, {
    attachments: [],
    authorName: "Responder",
    blocks: message.blocks,
    key: "thread-response",
    slackTimestamp: messageTimestamp,
    text: message.text,
  });

  const card = slackInvestigationCard({
    agentId: context.agentId,
    detail: "Completed the investigation plan.",
    investigationId: context.investigationId,
    organizationId: context.organizationId,
    showInvestigationLink: false,
    status: "complete",
    title: context.title,
    traceItems: context.traceItems,
  });
  const results = await Promise.allSettled([
    context.source.messageTimestamp
      ? updateSlackMessage({
          accessToken: token,
          blocks: card.blocks,
          channelId: context.source.channelId,
          text: card.text,
          timestamp: context.source.messageTimestamp,
        })
      : Promise.resolve(),
  ]);
  if (context.source.messageTimestamp && results[0]?.status === "fulfilled") {
    await recordInvestigationSlackReply(input.investigationId, {
      attachments: [],
      authorName: "Responder",
      blocks: card.blocks,
      key: "investigation-status",
      slackTimestamp: context.source.messageTimestamp,
      text: card.text,
    });
  }
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 0 && context.source.reactionTimestamp) {
    try {
      await removeSlackReaction({
        accessToken: token,
        channelId: context.source.channelId,
        name: "eyes",
        timestamp: context.source.reactionTimestamp,
      });
      await setInvestigationSlackReaction(input.investigationId, "eyes", false);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await setSlackThreadStatus({
      accessToken: token,
      channelId: context.source.channelId,
      status: "",
      threadTimestamp: context.source.threadTimestamp,
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Slack thread response cleanup failed");
  }
}

export function slackDeliveryErrorMessage(error: unknown): string {
  const fields = slackErrorLogFields(error);
  const diagnostics = (fields.slackErrors ?? []).flatMap((slackError) =>
    slackError.diagnostics.map(
      (diagnostic) =>
        `${slackError.method} ${slackError.code}: ${diagnostic}`,
    ),
  );
  return [fields.error, ...(fields.causes ?? []), ...diagnostics]
    .join(": ")
    .slice(0, 2_000);
}

export async function reconcileCompletedInvestigationSlackCard(
  investigationId: string,
): Promise<boolean> {
  const context =
    await getSlackInvestigationDeliveryContext(investigationId) ??
    await getSlackInvestigationLiveContext(investigationId);
  if (!context?.source?.messageTimestamp) return false;
  const token = accessToken(context.source.encryptedCredentials);
  const card = slackCompletedInvestigationCard(context);
  const results = await Promise.allSettled([
    updateSlackMessage({
      accessToken: token,
      blocks: card.blocks,
      channelId: context.source.channelId,
      text: card.text,
      timestamp: context.source.messageTimestamp,
    }),
    context.source.reactionTimestamp
      ? removeSlackReaction({
          accessToken: token,
          channelId: context.source.channelId,
          name: "eyes",
          timestamp: context.source.reactionTimestamp,
        })
      : Promise.resolve(),
    setSlackThreadStatus({
      accessToken: token,
      channelId: context.source.channelId,
      status: "",
      threadTimestamp: context.source.threadTimestamp,
    }),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (results[0]?.status === "fulfilled") {
    try {
      await recordInvestigationSlackReply(investigationId, {
        attachments: [],
        authorName: "Responder",
        blocks: card.blocks,
        key: "investigation-status",
        slackTimestamp: context.source.messageTimestamp,
        text: card.text,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (context.source.reactionTimestamp && results[1]?.status === "fulfilled") {
    try {
      await setInvestigationSlackReaction(investigationId, "eyes", false);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Slack completed investigation reconciliation failed",
    );
  }
  return true;
}

async function deliverSourceThread(
  context: SlackInvestigationDeliveryContext,
  deliveryRunId: string,
): Promise<void> {
  if (!context.source) return;
  const token = accessToken(context.source.encryptedCredentials);
  const failures: unknown[] = [];
  const summaryMessage = slackInvestigationSummaryMessage({
    issueCount: context.issues.length,
    summary: context.report.summary,
  });
  if (context.source.messageTimestamp) {
    const card = slackCompletedInvestigationCard(context);
    try {
      await updateSlackMessage({
        accessToken: token,
        blocks: card.blocks,
        channelId: context.source.channelId,
        text: card.text,
        timestamp: context.source.messageTimestamp,
      });
      await recordInvestigationSlackReply(context.investigationId, {
        attachments: [],
        authorName: "Responder",
        blocks: card.blocks,
        key: "investigation-status",
        slackTimestamp: context.source.messageTimestamp,
        text: card.text,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          ...slackErrorLogFields(error),
          event: "investigation_slack_card_update_failed",
          investigationId: context.investigationId,
        }),
      );
      failures.push(error);
    }
  }
  try {
    const messageTimestamp = await postSlackMessage({
      accessToken: token,
      blocks: summaryMessage.blocks,
      channelId: context.source.channelId,
      clientMessageId: slackDeliveryClientMessageId(
        deliveryRunId,
        `source:${context.source.channelId}:summary`,
      ),
      text: summaryMessage.text,
      threadTimestamp: context.source.threadTimestamp,
    });
    if (!messageTimestamp) {
      throw new Error("Slack did not return a message timestamp for the investigation summary");
    }
    await recordInvestigationSlackReply(context.investigationId, {
      attachments: [],
      authorName: "Responder",
      blocks: summaryMessage.blocks,
      key: "investigation-summary",
      slackTimestamp: messageTimestamp,
      text: summaryMessage.text,
    });
    const noIssueThreadLink = slackNoIssueThreadLink(context, messageTimestamp);
    if (noIssueThreadLink) {
      await recordSlackInvestigationThreadLink(noIssueThreadLink);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ...slackErrorLogFields(error),
        event: "investigation_slack_summary_post_failed",
        investigationId: context.investigationId,
      }),
    );
    failures.push(error);
  }
  for (const [issueIndex, issue] of context.issues.entries()) {
    const message = issueSlackMessage(context, issue);
    try {
      const messageTimestamp = await postSlackMessage({
        accessToken: token,
        blocks: message.blocks,
        channelId: context.source.channelId,
        clientMessageId: slackDeliveryClientMessageId(
          deliveryRunId,
          `source:${context.source.channelId}:issue:${issue.id}`,
        ),
        text: message.text,
        threadTimestamp: context.source.threadTimestamp,
      });
      if (!messageTimestamp) {
        throw new Error(`Slack did not return a message timestamp for issue ${issue.id}`);
      }
      await recordInvestigationSlackReply(context.investigationId, {
        attachments: [],
        authorName: "Responder",
        blocks: message.blocks,
        key: `issue:${issue.id}`,
        slackTimestamp: messageTimestamp,
        text: message.text,
      });
      if (context.source.teamId && context.organizationId) {
        await recordSlackInvestigationThreadLink({
          channelId: context.source.channelId,
          integrationAccountId: context.source.integrationAccountId,
          investigationId: context.investigationId,
          issueId: issue.id,
          messageTimestamp,
          organizationId: context.organizationId,
          teamId: context.source.teamId,
          threadTimestamp: context.source.threadTimestamp,
        });
      }
      await registerPullRequestMessage({
        channelId: context.source.channelId,
        integrationAccountId: context.source.integrationAccountId,
        issue,
        messageTimestamp,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          ...slackErrorLogFields(error),
          event: "investigation_slack_issue_post_failed",
          investigationId: context.investigationId,
          issueCount: context.issues.length,
          issueId: issue.id,
          issueIndex,
        }),
      );
      failures.push(error);
    }
  }
  const cleanup = await Promise.allSettled([
    addSlackReaction({
      accessToken: token,
      channelId: context.source.channelId,
      name: slackCompletionReaction(context.issues),
      timestamp: context.source.reactionTimestamp,
    }),
    removeSlackReaction({
      accessToken: token,
      channelId: context.source.channelId,
      name: "eyes",
      timestamp: context.source.reactionTimestamp,
    }),
    setSlackThreadStatus({
      accessToken: token,
      channelId: context.source.channelId,
      status: "",
      threadTimestamp: context.source.threadTimestamp,
    }),
  ]);
  failures.push(
    ...cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    ),
  );
  if (cleanup[0]?.status === "fulfilled") {
    try {
      await setInvestigationSlackReaction(
        context.investigationId,
        slackCompletionReaction(context.issues),
        true,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (cleanup[1]?.status === "fulfilled") {
    try {
      await setInvestigationSlackReaction(
        context.investigationId,
        "eyes",
        false,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Slack source thread delivery failed");
  }
}

async function deliverOutputChannel(
  context: SlackInvestigationDeliveryContext,
  deliveryRunId: string,
): Promise<void> {
  if (!context.output) return;
  const token = accessToken(context.output.encryptedCredentials);
  const issues = filterSlackOutputIssues(
    context.issues,
    context.output.severities,
  );
  for (const issue of issues) {
    const message = issueSlackMessage(context, issue);
    const messageTimestamp = await postSlackMessage({
      accessToken: token,
      blocks: message.blocks,
      channelId: context.output.channelId,
      clientMessageId: slackDeliveryClientMessageId(
        deliveryRunId,
        `output:${context.output.channelId}:issue:${issue.id}`,
      ),
      text: message.text,
    });
    await registerPullRequestMessage({
      channelId: context.output.channelId,
      integrationAccountId: context.output.integrationAccountId,
      issue,
      messageTimestamp,
    });
    if (messageTimestamp && context.output.teamId && context.organizationId) {
      await recordSlackInvestigationThreadLink({
        channelId: context.output.channelId,
        integrationAccountId: context.output.integrationAccountId,
        investigationId: context.investigationId,
        issueId: issue.id,
        messageTimestamp,
        organizationId: context.organizationId,
        teamId: context.output.teamId,
        threadTimestamp: messageTimestamp,
      });
    }
  }
}

export async function deliverInvestigationToSlack(
  investigationId: string,
  deliveryRunId: string,
): Promise<string[]> {
  const context = await getSlackInvestigationDeliveryContext(investigationId);
  if (!context) return [];
  const results = await Promise.allSettled([
    deliverSourceThread(context, deliveryRunId),
    deliverOutputChannel(context, deliveryRunId),
  ]);
  return results.flatMap((result) =>
    result.status === "rejected"
      ? [slackDeliveryErrorMessage(result.reason)]
      : [],
  );
}

/** Post follow-up feedback and the revised remediation back into the original issue thread. */
export async function deliverSlackIssueFollowupResponse(input: {
  channelId: string;
  deliveryRunId: string;
  originalInvestigationId: string;
  response: string;
  threadTimestamp: string;
  updatedIssueIds: string[];
}): Promise<void> {
  const links = await getSlackInvestigationThreadLinks(input.originalInvestigationId);
  if (links.length === 0) return;
  const context = await getSlackInvestigationDeliveryContext(input.originalInvestigationId);
  const link = links.find(
    (candidate) =>
      candidate.channelId === input.channelId &&
      candidate.threadTimestamp === input.threadTimestamp,
  ) ?? links[0]!;
  if (!link.encryptedCredentials) return;
  const credentials = accessToken(link.encryptedCredentials);
  const message = slackIssueFollowupMessage({
    context,
    response: input.response,
    updatedIssueIds: input.updatedIssueIds,
  });
  const timestamp = await postSlackMessage({
    accessToken: credentials,
    blocks: message.blocks,
    channelId: link.channelId,
    clientMessageId: slackDeliveryClientMessageId(input.deliveryRunId, "issue-followup"),
    text: message.text,
    threadTimestamp: link.threadTimestamp,
  });
  if (timestamp) {
    await recordInvestigationSlackReply(input.originalInvestigationId, {
      attachments: [],
      authorName: "Responder",
      blocks: message.blocks,
      key: `issue-followup:${input.deliveryRunId}`,
      slackTimestamp: timestamp,
      text: message.text,
    });
  }
}
