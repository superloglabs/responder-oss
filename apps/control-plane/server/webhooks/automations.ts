import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  automationAcceptsWebhook,
  AutomationConfigurationError,
} from "../../../../packages/core/src/db/automations.js";
import { automationWebhookToken } from "../../../../packages/core/src/integrations/webhook-secret.js";
import { queueAutomationRun } from "../automations/queue.js";
import { createRateLimiter } from "../rate-limit.js";

const maxBodyLength = 100_000;
const maxTitleLength = 500;
const idempotencyKeySchema = z.string().trim().min(1).max(255).regex(/^[\x21-\x7e]+$/u);

// Each request starts a run, so a caller in a loop is stopped before it
// starts more runs than anyone could read.
const webhookRuns = createRateLimiter({ limit: 30, windowMs: 60_000 });

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyAutomationWebhookAuthorization(input: {
  authorization: string | undefined;
  automationId: string;
}): boolean {
  const bearer = /^Bearer (.+)$/u.exec(input.authorization ?? "");
  return bearer ? safeEqual(bearer[1]!, automationWebhookToken(input.automationId)) : false;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// A JSON body is pretty-printed for the agent. Any other body is passed on
// as text.
export function automationWebhookTrigger(text: string): { body: string; title: string } {
  const json = text.trim() ? parseJson(text) : undefined;
  const body = json === undefined ? text : JSON.stringify(json, null, 2);
  const title = json && typeof json === "object" && !Array.isArray(json) &&
      "title" in json && typeof json.title === "string" && json.title.trim()
    ? json.title.trim().slice(0, maxTitleLength)
    : "Webhook request";
  return { body: body.slice(0, maxBodyLength) || "The request had no body.", title };
}

function logRejected(automationId: string, reason: string) {
  console.warn(JSON.stringify({ automationId, event: "automation_webhook_rejected", reason }));
}

export const automationWebhookRoutes = new Hono().post("/:automationId", async (context) => {
  const automationId = z.uuid().safeParse(context.req.param("automationId"));
  if (
    !automationId.success ||
    !verifyAutomationWebhookAuthorization({
      authorization: context.req.header("authorization"),
      automationId: automationId.data,
    })
  ) {
    if (automationId.success) logRejected(automationId.data, "invalid_token");
    return context.json({ error: "Invalid webhook token" }, 401);
  }

  const idempotencyHeader = context.req.header("idempotency-key");
  const idempotencyKey = idempotencyHeader === undefined
    ? undefined
    : idempotencyKeySchema.safeParse(idempotencyHeader);
  if (idempotencyKey && !idempotencyKey.success) {
    logRejected(automationId.data, "invalid_idempotency_key");
    return context.json({ error: "Idempotency-Key must be 1 to 255 printable ASCII characters" }, 400);
  }

  if (!(await automationAcceptsWebhook(automationId.data))) {
    logRejected(automationId.data, "not_accepting");
    return context.json({ error: "The automation is off or has no webhook trigger" }, 404);
  }

  const limit = webhookRuns.take(automationId.data);
  if (!limit.allowed) {
    if (limit.firstRefusal) logRejected(automationId.data, "rate_limited");
    context.header("retry-after", String(limit.retryAfterSeconds));
    return context.json({ error: "Too many webhook requests for this automation" }, 429);
  }

  const { body, title } = automationWebhookTrigger(await context.req.text());
  try {
    const run = await queueAutomationRun({
      automationId: automationId.data,
      trigger: {
        attributes: { contentType: context.req.header("content-type")?.slice(0, 255) ?? null },
        body,
        externalEventId: `webhook:${idempotencyKey?.data ?? randomUUID()}`,
        provider: "webhook",
        title,
      },
    });
    console.info(JSON.stringify({
      automationId: automationId.data,
      duplicate: run.duplicate,
      event: "automation_webhook_received",
      runId: run.runId,
    }));
    return context.json({ duplicate: run.duplicate, ok: true, runId: run.runId }, run.duplicate ? 200 : 202);
  } catch (error) {
    // The automation was turned off after the check above.
    if (error instanceof AutomationConfigurationError) {
      logRejected(automationId.data, "not_accepting");
      return context.json({ error: "The automation is off or has no webhook trigger" }, 404);
    }
    console.error("Unable to start webhook automation", error);
    return context.json({ error: "Unable to start the automation" }, 503);
  }
});
