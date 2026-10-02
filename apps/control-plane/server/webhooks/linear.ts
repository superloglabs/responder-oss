import { Hono } from "hono";
import { z } from "zod";
import {
  findLinearAgentTarget,
  sendLinearAgentActivity,
  type LinearAgentTarget,
} from "../../../../packages/core/src/db/linear-agent-sessions.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  linearAgentRequestBody,
  linearAgentSessionAttribute,
  linearAgentSessionEventSchema,
  linearIssueIdentifierAttribute,
  verifyLinearWebhook,
  type LinearAgentActivityContent,
  type LinearAgentSessionEvent,
} from "../../../../packages/core/src/integrations/linear-agent.js";
import { slackAssistantAttribute } from "../../../../packages/core/src/integrations/slack-assistant.js";
import { queueSlackThreadInvestigation } from "../investigations/queue.js";

export const linearTagModeOffMessage =
  "Tag mode is off in Responder. Turn it on in Settings to work on Linear requests.";
export const linearAllowanceMessage =
  "This Responder workspace has used its monthly request allowance.";

// Linear marks an agent unresponsive unless it posts an activity within ten
// seconds, and expects the webhook response within five. The activity is sent
// in the background so a slow token refresh cannot delay the response.
function postActivity(
  target: LinearAgentTarget,
  event: LinearAgentSessionEvent,
  content: LinearAgentActivityContent,
  options: { ephemeral?: boolean } = {},
): void {
  void sendLinearAgentActivity({
    agentSessionId: event.agentSession.id,
    content,
    ephemeral: options.ephemeral,
    integrationAccountId: target.integrationAccountId,
    organizationId: target.organizationId,
  }).catch((error: unknown) => {
    console.error(JSON.stringify({
      agentSessionId: event.agentSession.id,
      error: error instanceof Error ? error.message : "request failed",
      event: "linear_agent_activity_failed",
      organizationId: target.organizationId,
    }));
  });
}

function linearRequestTitle(event: LinearAgentSessionEvent): string {
  const issue = event.agentSession.issue;
  const title = issue
    ? `${issue.identifier}: ${issue.title}`.trim()
    : "Linear request";
  return title.slice(0, 500) || "Linear request";
}

function linearSourceUrl(event: LinearAgentSessionEvent): string | undefined {
  const url = z.url({ protocol: /^https$/ }).safeParse(
    event.agentSession.issue?.url,
  );
  return url.success ? url.data : undefined;
}

export const linearWebhookRoutes = new Hono().post("/", async (context) => {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) {
    return context.json({ error: "Linear webhooks are not configured" }, 503);
  }
  const body = await context.req.text();
  if (
    !verifyLinearWebhook({
      body,
      secret,
      signature: context.req.header("linear-signature"),
    })
  ) {
    return context.json({ error: "Invalid Linear signature" }, 401);
  }

  const parsed = linearAgentSessionEventSchema.safeParse(
    JSON.parse(body) as unknown,
  );
  if (!parsed.success) return context.json({ ok: true, ignored: true });
  const event = parsed.data;
  // A stop request has nothing to run. The current turn finishes on its own.
  if (event.agentActivity?.signal === "stop") {
    return context.json({ ok: true, ignored: true });
  }
  const requestBody = linearAgentRequestBody(event);
  if (!requestBody) return context.json({ ok: true, ignored: true });

  const target = await findLinearAgentTarget(event.organizationId);
  if (!target) return context.json({ ok: true, ignored: true });
  if (!target.tagMode?.enabled) {
    postActivity(target, event, { type: "error", body: linearTagModeOffMessage });
    return context.json({ ok: true, ignored: true });
  }

  const agentId = target.tagMode.agentId;
  const issue = event.agentSession.issue;
  const assistant = await organizationHasCapability(
    target.organizationId,
    "simplified_navigation",
  );
  const sourceUrl = linearSourceUrl(event);
  let result: Awaited<ReturnType<typeof queueSlackThreadInvestigation>>;
  try {
    result = await queueSlackThreadInvestigation(
      {
        agentId,
        provider: "linear",
        // Linear redelivers a failed webhook with the same session or
        // activity, so retries resolve to the same request.
        externalEventId: `${
          event.action === "created"
            ? event.agentSession.id
            : event.agentActivity?.id ?? event.agentSession.id
        }:${agentId}`,
        title: linearRequestTitle(event),
        body: requestBody,
        ...(sourceUrl ? { sourceUrl } : {}),
        attributes: {
          integrationAccountId: target.integrationAccountId,
          [linearAgentSessionAttribute]: event.agentSession.id,
          ...(issue
            ? {
                linearIssueId: issue.id,
                [linearIssueIdentifierAttribute]: issue.identifier,
              }
            : {}),
          ...(event.agentSession.creator?.name
            ? { linearUserName: event.agentSession.creator.name }
            : {}),
          ...(assistant ? { [slackAssistantAttribute]: true } : {}),
        },
      },
      {
        teamId: event.organizationId,
        channelId: issue?.id ?? "linear",
        threadTimestamp: event.agentSession.id,
      },
    );
  } catch (error) {
    console.error(JSON.stringify({
      agentSessionId: event.agentSession.id,
      error: error instanceof Error ? error.message : "request failed",
      event: "linear_agent_session_queue_failed",
      organizationId: target.organizationId,
    }));
    return context.json({ error: "Unable to start the Linear request" }, 502);
  }

  if (result.kind === "blocked") {
    postActivity(target, event, { type: "error", body: linearAllowanceMessage });
    return context.json({ ok: true, blocked: true });
  }
  if (result.kind === "queued") {
    postActivity(
      target,
      event,
      { type: "thought", body: "Working on it." },
      { ephemeral: true },
    );
  }
  return context.json({
    ok: true,
    duplicate: result.kind === "duplicate",
    investigationId: result.investigationId,
  });
});
