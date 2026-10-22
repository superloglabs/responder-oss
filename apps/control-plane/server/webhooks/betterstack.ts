import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { findAutomationsForBetterStackIncident } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import {
  betterStackIncidentUrl,
  betterStackWebhookSecret,
} from "../../../../packages/core/src/integrations/betterstack.js";
import { queueAutomationRun } from "../automations/queue.js";

// The default template renders an empty value as "" and the JSON body Better
// Stack builds itself sends null, so both mean "not set".
const optionalText = z.string().nullable().optional().catch(undefined)
  .transform((value) => value?.trim() || undefined);

// Better Stack's default outgoing incident webhook body. Every attribute is
// optional because a member can replace the body with a template.
const betterStackIncidentSchema = z.object({
  data: z.object({
    attributes: z.object({
      acknowledged_at: optionalText,
      cause: optionalText,
      name: optionalText,
      resolved_at: optionalText,
      started_at: optionalText,
      url: optionalText,
    }).passthrough(),
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)),
    relationships: z.object({
      monitor: z.object({
        data: z.object({ id: z.union([z.string(), z.number()]).transform(String) }).nullable(),
      }).optional().catch(undefined),
    }).passthrough().optional().catch(undefined),
    type: z.string().optional(),
  }).passthrough(),
  event: optionalText,
}).passthrough();

type BetterStackIncident = z.infer<typeof betterStackIncidentSchema>;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

// The webhook sends the secret as the basic auth password. A member who adds
// an Authorization header instead can send it as a bearer token.
export function verifyBetterStackWebhookAuthorization(input: {
  authorization: string | undefined;
  integrationAccountId: string;
}): boolean {
  const authorization = input.authorization ?? "";
  const secret = betterStackWebhookSecret(input.integrationAccountId);
  const bearer = /^Bearer (.+)$/u.exec(authorization);
  if (bearer) return safeEqual(bearer[1]!, secret);
  const basic = /^Basic ([A-Za-z0-9+/=]+)$/u.exec(authorization);
  if (!basic) return false;
  const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator >= 0 && safeEqual(decoded.slice(separator + 1), secret);
}

function betterStackIncidentTitle(incident: BetterStackIncident): string {
  const { cause, name } = incident.data.attributes;
  const title = name && cause ? `${name}: ${cause}` : name ?? cause ?? "Better Stack incident";
  return title.slice(0, 500);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const betterStackWebhookRoutes = new Hono().post("/:accountId", async (context) => {
  const accountId = z.uuid().safeParse(context.req.param("accountId"));
  if (!accountId.success) {
    return context.json({ error: "Invalid Better Stack webhook credentials" }, 401);
  }
  const account = await getConnectedIntegrationAccountCredential({
    integrationAccountId: accountId.data,
    provider: "betterstack",
  });
  if (
    !account ||
    !verifyBetterStackWebhookAuthorization({
      authorization: context.req.header("authorization"),
      integrationAccountId: accountId.data,
    })
  ) {
    console.warn(
      JSON.stringify({
        event: "betterstack_webhook_rejected",
        integrationAccountId: accountId.data,
        reason: account ? "invalid_credentials" : "connection_not_found",
      }),
    );
    return context.json({ error: "Invalid Better Stack webhook credentials" }, 401);
  }

  const payload = parseJson(await context.req.text());
  const parsed = betterStackIncidentSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: "betterstack_webhook_rejected",
        integrationAccountId: accountId.data,
        reason: "invalid_payload",
      }),
    );
    return context.json({ error: "Invalid Better Stack incident payload" }, 400);
  }
  const incident = parsed.data;
  const { attributes } = incident.data;
  console.info(
    JSON.stringify({
      event: "betterstack_webhook_received",
      incidentEvent: incident.event ?? null,
      incidentId: incident.data.id,
      integrationAccountId: accountId.data,
      type: incident.data.type ?? null,
    }),
  );
  // The incident webhook also fires when an incident is acknowledged,
  // resolved, or commented on. Only a new, open incident starts a run.
  // Monitor and on-call webhooks sent here are ignored.
  if (
    (incident.data.type && incident.data.type !== "incident") ||
    incident.event === "comment" ||
    attributes.acknowledged_at ||
    attributes.resolved_at
  ) {
    return context.json({ ok: true, ignored: true });
  }

  // An incident starts once, so its ID and start time identify it. A retry
  // or a second webhook for the same incident does not start another run.
  const occurrence = attributes.started_at ?? "started";
  const monitorId = incident.data.relationships?.monitor?.data?.id ?? null;
  const matches = await findAutomationsForBetterStackIncident(accountId.data);
  try {
    await Promise.all(
      matches.map((match) =>
        queueAutomationRun({
          automationId: match.automationId,
          trigger: {
            attributes: {
              cause: attributes.cause ?? null,
              incidentId: incident.data.id,
              incidentName: attributes.name ?? null,
              integrationAccountId: accountId.data,
              monitorId,
              startedAt: attributes.started_at ?? null,
              url: attributes.url ?? null,
            },
            body: JSON.stringify(payload, null, 2).slice(0, 100_000),
            externalEventId: `${accountId.data}:${incident.data.id}:${occurrence}`,
            provider: "betterstack",
            sourceUrl: betterStackIncidentUrl(incident.data.id),
            title: betterStackIncidentTitle(incident),
          },
        })
      ),
    );
  } catch (error) {
    console.error("Unable to fan out Better Stack incident", error);
    return context.json({ error: "Unable to start Better Stack automation" }, 502);
  }

  return context.json({ ok: true, matchedAutomations: matches.length });
});
