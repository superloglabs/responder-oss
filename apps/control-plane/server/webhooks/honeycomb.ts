import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { findAutomationsForHoneycombAlert } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { honeycombWebhookSecret } from "../../../../packages/core/src/integrations/honeycomb.js";
import { queueAutomationRun } from "../automations/queue.js";

const optionalText = z.string().optional().catch(undefined);

// Honeycomb's default webhook body for triggers and SLO burn alerts. Fields
// other than the name and status are optional because burn alerts send a
// different set and a member can replace the body with a template.
const honeycombAlertSchema = z.object({
  description: optionalText,
  id: optionalText,
  is_test: z.boolean().optional().catch(undefined),
  name: z.string().min(1),
  operator: optionalText,
  result_url: optionalText,
  slo_url: optionalText,
  status: z.string().min(1),
  summary: optionalText,
  threshold: z.union([z.number(), z.string()]).nullable().optional().catch(undefined),
  trigger_description: optionalText,
  trigger_url: optionalText,
}).passthrough();

type HoneycombAlert = z.infer<typeof honeycombAlertSchema>;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

// The webhook recipient's shared secret arrives in X-Honeycomb-Webhook-Token.
export function verifyHoneycombWebhookToken(input: {
  integrationAccountId: string;
  token: string | undefined;
}): boolean {
  if (!input.token) return false;
  return safeEqual(input.token, honeycombWebhookSecret(input.integrationAccountId));
}

function honeycombAlertTitle(alert: HoneycombAlert): string {
  const title = alert.summary?.trim() || alert.name.trim();
  return title.slice(0, 500);
}

function httpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const honeycombWebhookRoutes = new Hono().post("/:accountId", async (context) => {
  const accountId = z.uuid().safeParse(context.req.param("accountId"));
  if (!accountId.success) {
    return context.json({ error: "Invalid Honeycomb webhook token" }, 401);
  }
  const account = await getConnectedIntegrationAccountCredential({
    integrationAccountId: accountId.data,
    provider: "honeycomb",
  });
  if (
    !account ||
    !verifyHoneycombWebhookToken({
      integrationAccountId: accountId.data,
      token: context.req.header("x-honeycomb-webhook-token"),
    })
  ) {
    console.warn(
      JSON.stringify({
        event: "honeycomb_webhook_rejected",
        integrationAccountId: accountId.data,
        reason: account ? "invalid_token" : "connection_not_found",
      }),
    );
    return context.json({ error: "Invalid Honeycomb webhook token" }, 401);
  }

  const rawBody = await context.req.text();
  const parsed = honeycombAlertSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: "honeycomb_webhook_rejected",
        integrationAccountId: accountId.data,
        reason: "invalid_payload",
      }),
    );
    return context.json({ error: "Invalid Honeycomb alert payload" }, 400);
  }
  const alert = parsed.data;
  console.info(
    JSON.stringify({
      alertId: alert.id ?? null,
      event: "honeycomb_webhook_received",
      integrationAccountId: accountId.data,
      status: alert.status,
      test: alert.is_test === true,
    }),
  );
  // Honeycomb sends TRIGGERED when an alert fires and OK when it resolves.
  // The Test button in Honeycomb confirms delivery without starting a run.
  if (alert.status.toUpperCase() !== "TRIGGERED" || alert.is_test === true) {
    return context.json({ ok: true, ignored: true });
  }

  // A retry carries the same delivery ID and body, so it gets the same event
  // ID. Each new firing is a new delivery.
  const deliveryId = context.req.header("x-honeycomb-webhook-delivery-id")?.trim();
  const occurrence = deliveryId
    ? deliveryId.slice(0, 200)
    : createHash("sha256").update(rawBody, "utf8").digest("hex");
  const sourceUrl = httpsUrl(alert.result_url) ?? httpsUrl(alert.trigger_url) ?? httpsUrl(alert.slo_url);
  // The default body repeats the recipient's shared secret.
  const body = Object.fromEntries(Object.entries(alert).filter(([key]) => key !== "shared_secret"));
  const matches = await findAutomationsForHoneycombAlert(accountId.data);
  try {
    await Promise.all(
      matches.map((match) =>
        queueAutomationRun({
          automationId: match.automationId,
          trigger: {
            attributes: {
              alertId: alert.id ?? null,
              alertName: alert.name,
              integrationAccountId: accountId.data,
              operator: alert.operator ?? null,
              status: alert.status,
              threshold: alert.threshold ?? null,
            },
            body: JSON.stringify(body, null, 2).slice(0, 100_000),
            externalEventId: `${accountId.data}:${alert.id ?? "alert"}:${occurrence}`,
            provider: "honeycomb",
            ...(sourceUrl ? { sourceUrl } : {}),
            title: honeycombAlertTitle(alert),
          },
        })
      ),
    );
  } catch (error) {
    console.error("Unable to fan out Honeycomb alert", error);
    return context.json({ error: "Unable to start Honeycomb automation" }, 502);
  }

  return context.json({ ok: true, matchedAutomations: matches.length });
});
