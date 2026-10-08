import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { findAutomationsForAxiomAlert } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { axiomWebhookSecret } from "../../../../packages/core/src/integrations/axiom.js";
import { queueAutomationRun } from "../automations/queue.js";

// Axiom's custom webhook notifier body. Text fields are optional because a
// member can edit the body template in Axiom.
const axiomAlertSchema = z.object({
  action: z.string().min(1),
  event: z
    .object({
      monitorID: z.string().min(1),
      title: z.string().optional(),
      description: z.string().optional(),
      body: z.string().optional(),
      queryStartTime: z.string().optional(),
      queryEndTime: z.string().optional(),
      timestamp: z.string().optional(),
      value: z.union([z.number(), z.string()]).nullable().optional(),
      matchedEvent: z.record(z.string(), z.unknown()).nullable().optional(),
      groupKeys: z.array(z.string()).nullable().optional(),
      groupValues: z.array(z.unknown()).nullable().optional(),
    })
    .passthrough(),
});

type AxiomAlertEvent = z.infer<typeof axiomAlertSchema>["event"];

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyAxiomWebhookAuthorization(input: {
  authorization: string | undefined;
  integrationAccountId: string;
}): boolean {
  const prefix = "Bearer ";
  if (!input.authorization?.startsWith(prefix)) return false;
  return safeEqual(
    input.authorization.slice(prefix.length),
    axiomWebhookSecret(input.integrationAccountId),
  );
}

export function axiomAlertBody(event: AxiomAlertEvent): string {
  return JSON.stringify(event, null, 2).slice(0, 100_000);
}

function axiomAlertTitle(event: AxiomAlertEvent): string {
  const title = event.title?.trim() || `Axiom monitor ${event.monitorID}`;
  return title.slice(0, 500);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const axiomWebhookRoutes = new Hono().post("/:accountId", async (context) => {
  const accountId = z.uuid().safeParse(context.req.param("accountId"));
  if (!accountId.success) {
    return context.json({ error: "Invalid Axiom webhook authorization" }, 401);
  }
  const account = await getConnectedIntegrationAccountCredential({
    integrationAccountId: accountId.data,
    provider: "axiom",
  });
  if (
    !account ||
    !verifyAxiomWebhookAuthorization({
      authorization: context.req.header("authorization"),
      integrationAccountId: accountId.data,
    })
  ) {
    console.warn(
      JSON.stringify({
        event: "axiom_webhook_rejected",
        integrationAccountId: accountId.data,
        reason: account ? "invalid_authorization" : "connection_not_found",
      }),
    );
    return context.json({ error: "Invalid Axiom webhook authorization" }, 401);
  }

  const rawBody = await context.req.text();
  const parsed = axiomAlertSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: "axiom_webhook_rejected",
        integrationAccountId: accountId.data,
        reason: "invalid_payload",
      }),
    );
    return context.json({ error: "Invalid Axiom alert payload" }, 400);
  }
  // A monitor sends Open when it starts alerting and Closed when it
  // recovers. Only a new alert starts a run.
  if (parsed.data.action !== "Open") {
    return context.json({ ok: true, ignored: true });
  }

  const { event } = parsed.data;
  // One alert is one monitor, group, and evaluation window, or one matched
  // event. A retry of the same alert gets the same ID however its body is
  // formatted.
  const occurrence = createHash("sha256").update(JSON.stringify([
    event.groupValues ?? null,
    event.matchedEvent ?? null,
    event.queryStartTime ?? null,
    event.queryEndTime ?? null,
    event.timestamp ?? null,
  ]), "utf8").digest("hex");
  console.info(
    JSON.stringify({
      event: "axiom_webhook_received",
      integrationAccountId: accountId.data,
      monitorId: event.monitorID,
    }),
  );
  const matches = await findAutomationsForAxiomAlert(accountId.data);
  try {
    await Promise.all(
      matches.map((match) =>
        queueAutomationRun({
          automationId: match.automationId,
          trigger: {
            attributes: {
              action: parsed.data.action,
              integrationAccountId: accountId.data,
              monitorId: event.monitorID,
              queryEndTime: event.queryEndTime ?? null,
              queryStartTime: event.queryStartTime ?? null,
              timestamp: event.timestamp ?? null,
              value: event.value ?? null,
            },
            body: axiomAlertBody(event),
            externalEventId: `${accountId.data}:${event.monitorID}:${occurrence}`,
            provider: "axiom",
            title: axiomAlertTitle(event),
          },
        })
      ),
    );
  } catch (error) {
    console.error("Unable to fan out Axiom alert", error);
    return context.json({ error: "Unable to start Axiom automation" }, 502);
  }

  return context.json({ ok: true, matchedAutomations: matches.length });
});
