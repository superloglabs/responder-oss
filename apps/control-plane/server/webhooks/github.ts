import { createHmac, timingSafeEqual } from "node:crypto";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { markPullRequestOriginMerged } from "@responder/core/db/pull-request-origins";
import { markIssuePullRequestMerged } from "@responder/core/db/pull-requests";
import { markSuggestionPullRequestMerged } from "@responder/core/db/suggestion-pull-requests";
import { refreshIssuePullRequestSlackMessages } from "@responder/core/integrations/slack-remediations";
import { Hono } from "hono";
import { z } from "zod";
import {
  pullRequestReviewEventSchema,
  startPullRequestReviewTurn,
} from "./github-reviews.js";

const pullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean().optional(),
    html_url: z.string().optional(),
  }),
  repository: z.object({
    full_name: z.string().min(1),
  }),
});

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyGitHubSignature(input: {
  rawBody: string;
  signature: string | undefined;
  webhookSecret?: string;
}): boolean {
  const webhookSecret = input.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret || !input.signature) return false;
  const digest = `sha256=${createHmac("sha256", webhookSecret)
    .update(input.rawBody, "utf8")
    .digest("hex")}`;
  return safeEqual(digest, input.signature);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const githubWebhookRoutes = new Hono().post("/", async (context) => {
  const rawBody = await context.req.text();
  if (
    !verifyGitHubSignature({
      rawBody,
      signature: context.req.header("x-hub-signature-256"),
    })
  ) {
    console.warn(
      JSON.stringify({
        event: "github_webhook_rejected",
        reason: "invalid_signature",
      }),
    );
    return context.json({ error: "Invalid GitHub signature" }, 401);
  }

  const eventType = context.req.header("x-github-event");
  if (eventType === "pull_request_review") {
    const parsed = pullRequestReviewEventSchema.safeParse(parseJson(rawBody));
    if (!parsed.success) return context.json({ ok: true, ignored: true });
    const outcome = await startPullRequestReviewTurn(parsed.data);
    if (outcome !== "ignored" && outcome !== "not_ours") {
      console.info(
        JSON.stringify({
          event: "github_pull_request_review_turn",
          outcome,
          pullRequestNumber: parsed.data.pull_request.number,
          repository: parsed.data.repository.full_name,
          reviewId: parsed.data.review.id,
        }),
      );
    }
    return context.json({ ok: true, outcome });
  }

  if (eventType !== "pull_request") {
    return context.json({ ok: true, ignored: true });
  }

  const parsed = pullRequestEventSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) {
    return context.json({ ok: true, ignored: true });
  }

  const { action, pull_request: pullRequest, repository } = parsed.data;
  if (action !== "closed" || pullRequest.merged !== true) {
    return context.json({ ok: true, ignored: true });
  }

  const mergedIssue = await markIssuePullRequestMerged({
    repositoryFullName: repository.full_name,
    pullRequestNumber: pullRequest.number,
  });
  const mergedSuggestion = mergedIssue
    ? null
    : await markSuggestionPullRequestMerged({
        repositoryFullName: repository.full_name,
        pullRequestNumber: pullRequest.number,
      });
  const merged = mergedIssue ?? mergedSuggestion;
  if (!merged) {
    // Pull requests opened by automations and Slack threads keep their merge
    // time on their origin.
    const mergedOrigin = await markPullRequestOriginMerged({
      pullRequestNumber: pullRequest.number,
      repositoryFullName: repository.full_name,
    });
    return context.json({ ok: true, matched: mergedOrigin });
  }
  if (mergedIssue) {
    await refreshIssuePullRequestSlackMessages(merged.requestId);
  }

  console.info(
    JSON.stringify({
      event: "github_pull_request_merged",
      organizationId: merged.organizationId,
      pullRequestNumber: pullRequest.number,
      repository: repository.full_name,
    }),
  );
  await captureAnalyticsEvent({
    distinctId: `investigation:${merged.investigationId}`,
    event: "pr merged",
    organizationId: merged.organizationId,
    properties: {
      $process_person_profile: false,
      agent_config_version_id: merged.agentConfigVersionId,
      investigation_id: merged.investigationId,
      ...(mergedIssue
        ? { issue_id: mergedIssue.issueId }
        : { suggestion_id: mergedSuggestion!.suggestionId }),
      pr_number: pullRequest.number,
      pr_url: merged.pullRequestUrl ?? pullRequest.html_url ?? null,
      repository: repository.full_name,
    },
  });

  return context.json({ ok: true, matched: true });
});
