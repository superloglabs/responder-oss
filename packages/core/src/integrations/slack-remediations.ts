import { z } from "zod";
import { decryptCredentials } from "../credentials/encryption.js";
import {
  getIssuePullRequestSlackCard,
  getIssuePullRequestSlackDeliveries,
} from "../db/pull-requests.js";
import type { IssueRemediation } from "../investigations/report.js";
import { responderIssueUrl } from "../responder-urls.js";
import { updateSlackMessage } from "./slack.js";

const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});

const remediationActionValueSchema = z.object({
  issueId: z.uuid(),
  remediationId: z.uuid(),
});

export type SlackRemediationActionValue = z.infer<
  typeof remediationActionValueSchema
>;

function escapeSlack(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 1).trimEnd()}…`
    : value;
}

function remediationKind(remediation: IssueRemediation): string {
  return remediation.type === "code_change" ? "Code change" : "External action";
}

function responderAppUrl(): string {
  return (
    process.env.RESPONDER_APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

export function slackCodeChangeUrl(
  issueId: string,
  remediationId: string,
): string {
  const url = new URL(responderIssueUrl(issueId, responderAppUrl()));
  url.searchParams.set("codeChange", remediationId);
  url.hash = `remediation-${remediationId}`;
  return url.toString();
}

export function slackRemediationActionValue(
  issueId: string,
  remediationId: string,
): string {
  return JSON.stringify({ issueId, remediationId });
}

export function parseSlackRemediationActionValue(
  value: string,
): SlackRemediationActionValue | null {
  try {
    const parsed = remediationActionValueSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function slackRemediationCard(input: {
  issueId: string;
  remediation: IssueRemediation;
  selectable?: boolean;
}) {
  const actions = input.remediation.type === "code_change"
    ? [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "See code change",
            emoji: false,
          },
          action_id: "view_code_change",
          url: slackCodeChangeUrl(input.issueId, input.remediation.id),
          value: slackRemediationActionValue(
            input.issueId,
            input.remediation.id,
          ),
        },
        ...(input.selectable === false
          ? []
          : [{
              type: "button",
              text: { type: "plain_text", text: "Open PR", emoji: false },
              style: "primary",
              action_id: "create_issue_pull_request",
              value: slackRemediationActionValue(
                input.issueId,
                input.remediation.id,
              ),
            }]),
      ]
    : input.selectable === false
      ? []
      : [{
          type: "button",
          text: { type: "plain_text", text: "Copy prompt", emoji: false },
          action_id: "copy_issue_prompt",
          value: slackRemediationActionValue(
            input.issueId,
            input.remediation.id,
          ),
        }];
  return {
    type: "card",
    block_id: `remediation-${input.remediation.id}`,
    title: {
      type: "mrkdwn",
      text: truncate(escapeSlack(input.remediation.title), 200),
      verbatim: false,
    },
    subtitle: {
      type: "mrkdwn",
      text: remediationKind(input.remediation),
      verbatim: false,
    },
    body: {
      type: "mrkdwn",
      text: truncate(escapeSlack(input.remediation.description), 2_900),
      verbatim: false,
    },
    ...(actions.length > 0 ? { actions } : {}),
  };
}

export function slackRemediationCarousel(input: {
  canCreatePullRequest: boolean;
  issueId: string;
  remediations: IssueRemediation[];
}): unknown[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Remediations", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "You can use any of these remediations.",
      },
    },
    {
      type: "carousel",
      elements: input.remediations.map((remediation) =>
        slackRemediationCard({
          issueId: input.issueId,
          remediation,
          selectable:
            remediation.type === "external_action" ||
            input.canCreatePullRequest,
        }),
      ),
    },
  ];
}

export interface SlackIssuePullRequestCard {
  failureReason: string | null;
  issueId: string;
  issueSeverity: "SEV-1" | "SEV-2" | "SEV-3";
  issueTitle: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  repositoryFullName: string | null;
  requestId: string;
  selectedRemediation: IssueRemediation;
  status: "queued" | "creating" | "created" | "merged" | "failed";
}

function pullRequestStatus(card: SlackIssuePullRequestCard): {
  body: string;
  label: string;
} {
  switch (card.status) {
    case "queued":
      return {
        body: "The selected remediation is queued and will start shortly.",
        label: "Queued",
      };
    case "creating":
      return {
        body: "Applying the selected remediation and preparing the pull request.",
        label: "Creating",
      };
    case "created":
      return {
        body:
          card.repositoryFullName && card.pullRequestNumber
            ? `${escapeSlack(card.repositoryFullName)} #${card.pullRequestNumber}`
            : "The pull request is ready for review.",
        label: "Open",
      };
    case "merged":
      return {
        body:
          card.repositoryFullName && card.pullRequestNumber
            ? `${escapeSlack(card.repositoryFullName)} #${card.pullRequestNumber}`
            : "The pull request was merged.",
        label: "Merged",
      };
    case "failed":
      return {
        body: truncate(
          escapeSlack(
            card.failureReason ?? "Responder could not create the pull request.",
          ),
          2_900,
        ),
        label: "Failed",
      };
  }
}

export function slackIssuePullRequestMessage(card: SlackIssuePullRequestCard): {
  blocks: unknown[];
  text: string;
} {
  const status = pullRequestStatus(card);
  const issueUrl = responderIssueUrl(card.issueId, responderAppUrl());
  const pullRequestActions = [
    ...(card.pullRequestUrl
      ? [{
          type: "button",
          action_id: "open_pull_request",
          text: { type: "plain_text", text: "Open PR", emoji: false },
          url: card.pullRequestUrl,
          value: card.requestId,
        }]
      : []),
    {
      type: "button",
      action_id: "view_issue",
      text: { type: "plain_text", text: "View issue", emoji: false },
      url: issueUrl,
      value: card.issueId,
    },
  ];
  return {
    text: `${card.issueSeverity} — ${card.issueTitle}\n${card.selectedRemediation.title}\nPull request: ${status.label}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${card.issueSeverity} — ${escapeSlack(card.issueTitle)}*`,
        },
      },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Selected remediation",
          emoji: true,
        },
      },
      {
        type: "carousel",
        elements: [
          slackRemediationCard({
            issueId: card.issueId,
            remediation: card.selectedRemediation,
            selectable: false,
          }),
        ],
      },
      {
        type: "header",
        text: { type: "plain_text", text: "Pull request", emoji: true },
      },
      {
        type: "carousel",
        elements: [
          {
            type: "card",
            block_id: `pull-request-${card.requestId}`,
            title: {
              type: "mrkdwn",
              text: "Pull request",
              verbatim: false,
            },
            subtitle: {
              type: "mrkdwn",
              text: status.label,
              verbatim: false,
            },
            body: {
              type: "mrkdwn",
              text: status.body,
              verbatim: false,
            },
            actions: pullRequestActions,
          },
        ],
      },
    ],
  };
}

export async function refreshIssuePullRequestSlackMessages(
  requestId: string,
): Promise<void> {
  try {
    const [card, deliveries] = await Promise.all([
      getIssuePullRequestSlackCard(requestId),
      getIssuePullRequestSlackDeliveries(requestId),
    ]);
    if (!card || deliveries.length === 0) return;
    const message = slackIssuePullRequestMessage(card);
    const updates = await Promise.allSettled(
      deliveries.map(async (delivery) => {
        if (!delivery.encryptedCredentials) {
          throw new Error("Slack credentials are unavailable");
        }
        const credentials = slackCredentialsSchema.parse(
          decryptCredentials<Record<string, unknown>>(
            delivery.encryptedCredentials,
          ),
        );
        await updateSlackMessage({
          accessToken: credentials.accessToken,
          blocks: message.blocks,
          channelId: delivery.channelId,
          text: message.text,
          timestamp: delivery.messageTimestamp,
        });
      }),
    );
    for (const update of updates) {
      if (update.status === "rejected") {
        console.error(
          JSON.stringify({
            error:
              update.reason instanceof Error
                ? update.reason.message
                : String(update.reason),
            event: "issue_pull_request_slack_update_failed",
            requestId,
          }),
        );
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "issue_pull_request_slack_update_failed",
        requestId,
      }),
    );
  }
}
