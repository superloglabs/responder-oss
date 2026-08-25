import { createHash } from "node:crypto";
import { z } from "zod";
import { decryptCredentials } from "../credentials/encryption.js";
import { responderIssueUrl } from "../responder-urls.js";
import {
  getSlackInvestigationDeliveryContext,
  type SlackInvestigationDeliveryContext,
} from "../db/issues.js";
import { registerIssuePullRequestSlackMessage } from "../db/pull-requests.js";
import {
  addSlackReaction,
  postSlackMessage,
  removeSlackReaction,
  setSlackThreadStatus,
  updateSlackMessage,
} from "./slack.js";
import {
  refreshIssuePullRequestSlackMessages,
  slackIssuePullRequestMessage,
  slackRemediationCarousel,
} from "./slack-remediations.js";
import {
  slackErrorLogFields,
  slackInvestigationCard,
} from "./slack-live-card.js";

const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});

type DeliveryIssue = SlackInvestigationDeliveryContext["issues"][number];

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
  canCreatePullRequest = false,
): { blocks: unknown[]; text: string } {
  const recurrence = issue.relationship === "recurrence" ? " · Recurrence" : "";
  const timelineEntries = issue.timeline ?? [];
  const timeline = timelineEntries
    .map((entry, index) => `${index + 1}. ${entry.title} — ${entry.description}`)
    .join("\n");
  const text = [
    `${issue.severity} — ${issue.title}${recurrence}`,
    issue.description,
    issue.rootCause ? `Root cause: ${issue.rootCause}` : null,
    timeline ? `Timeline:\n${timeline}` : null,
  ].filter((value): value is string => Boolean(value)).join("\n\n");
  const issueUrl = responderIssueUrl(issue.id, responderAppUrl());
  const blockText = truncateSlackBlock(
    [
      `*${issue.severity} — ${escapeSlack(issue.title)}*${recurrence}`,
      escapeSlack(issue.description),
      issue.rootCause
        ? `*Root cause*\n${escapeSlack(issue.rootCause)}`
        : null,
      timelineEntries.length > 0
        ? `*Timeline*\n${timelineEntries
            .map(
              (entry, index) =>
                `${index + 1}. *${escapeSlack(entry.title)}* — ${escapeSlack(entry.description)}`,
            )
            .join("\n")}`
        : null,
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
      })
    : slackIssueMessage(
        issue,
        context.prMode === "manual" &&
          issue.remediations.some(
            (remediation) => remediation.type === "code_change",
          ),
      );
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

function completedInvestigationCard(context: SlackInvestigationDeliveryContext) {
  return slackInvestigationCard({
    agentId: context.agentId,
    detail: "Completed the investigation plan.",
    investigationId: context.investigationId,
    status: "complete",
    title: context.title,
    traceItems: context.traceItems ?? [],
  });
}

export function slackDeliveryErrorMessage(error: unknown): string {
  const fields = slackErrorLogFields(error);
  return [fields.error, ...(fields.causes ?? [])].join(": ");
}

export async function reconcileCompletedInvestigationSlackCard(
  investigationId: string,
): Promise<boolean> {
  const context = await getSlackInvestigationDeliveryContext(investigationId);
  if (!context?.source?.messageTimestamp) return false;
  const token = accessToken(context.source.encryptedCredentials);
  const card = completedInvestigationCard(context);
  const results = await Promise.allSettled([
    updateSlackMessage({
      accessToken: token,
      blocks: card.blocks,
      channelId: context.source.channelId,
      text: card.text,
      timestamp: context.source.messageTimestamp,
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
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
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
  const completionText = slackThreadCompletionText(
    context.report.summary,
    context.issues.length,
  );
  if (context.source.messageTimestamp) {
    const card = completedInvestigationCard(context);
    try {
      await updateSlackMessage({
        accessToken: token,
        blocks: card.blocks,
        channelId: context.source.channelId,
        text: card.text,
        timestamp: context.source.messageTimestamp,
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
    await postSlackMessage({
      accessToken: token,
      channelId: context.source.channelId,
      clientMessageId: slackDeliveryClientMessageId(
        deliveryRunId,
        `source:${context.source.channelId}:summary`,
      ),
      text: completionText,
      threadTimestamp: context.source.threadTimestamp,
    });
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
