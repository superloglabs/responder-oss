import { Hono } from "hono";
import { z } from "zod";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { findAutomationsForDevRevTicket } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import {
  devrevTicketUrl,
  parseDevRevCredentials,
  verifyDevRevSignature,
} from "../../../../packages/core/src/integrations/devrev.js";
import { queueAutomationRun } from "../automations/queue.js";

// DevRev confirms a new webhook with an unsigned challenge. Older webhooks
// send it at the top level.
const devrevVerifySchema = z.union([
  z.object({ type: z.literal("verify"), verify: z.object({ challenge: z.string().min(1) }) }),
  z.object({ challenge: z.string().min(1), type: z.literal("webhook_verify") }),
]);

// A work item as DevRev's API returns it. Only the fields Responder reads are
// listed; the rest reach the run as they are.
const devrevWorkSchema = z
  .object({
    display_id: z.string().min(1),
    id: z.string().min(1),
    severity: z.string().nullish(),
    title: z.string().nullish(),
    type: z.string().min(1),
  })
  .passthrough();

const devrevWorkCreatedSchema = z.object({
  type: z.literal("work_created"),
  work_created: z.object({ work: devrevWorkSchema }),
});

type DevRevWork = z.infer<typeof devrevWorkSchema>;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function devrevTicketBody(work: DevRevWork): string {
  return JSON.stringify(work, null, 2).slice(0, 100_000);
}

function devrevTicketTitle(work: DevRevWork): string {
  const title = work.title?.trim();
  return (title ? `${work.display_id}: ${title}` : work.display_id).slice(0, 500);
}

function rejected(integrationAccountId: string, reason: string): void {
  console.warn(JSON.stringify({ event: "devrev_webhook_rejected", integrationAccountId, reason }));
}

export const devrevWebhookRoutes = new Hono().post("/:accountId", async (context) => {
  const accountId = z.uuid().safeParse(context.req.param("accountId"));
  if (!accountId.success) {
    return context.json({ error: "Invalid DevRev webhook signature" }, 401);
  }
  const rawBody = await context.req.text();
  const payload = parseJson(rawBody);

  // Echoing the challenge proves only that this URL is reachable. Events
  // still need the secret Responder stored for the connection.
  const verification = devrevVerifySchema.safeParse(payload);
  if (verification.success) {
    const challenge = verification.data.type === "verify"
      ? verification.data.verify.challenge
      : verification.data.challenge;
    return context.json({ challenge });
  }

  const account = await getConnectedIntegrationAccountCredential({
    integrationAccountId: accountId.data,
    provider: "devrev",
  });
  let secret: string | undefined;
  try {
    secret = account?.encryptedCredentials
      ? parseDevRevCredentials(decryptCredentials(account.encryptedCredentials)).webhookSecret
      : undefined;
  } catch {
    secret = undefined;
  }
  if (!account || !secret) {
    rejected(accountId.data, "connection_not_found");
    return context.json({ error: "Invalid DevRev webhook signature" }, 401);
  }
  if (!verifyDevRevSignature({
    body: rawBody,
    secret,
    signature: context.req.header("x-devrev-signature"),
  })) {
    rejected(accountId.data, "invalid_signature");
    return context.json({ error: "Invalid DevRev webhook signature" }, 401);
  }

  const event = devrevWorkCreatedSchema.safeParse(payload);
  // The webhook also receives issues and other work items. Only tickets
  // start a run.
  if (!event.success || event.data.work_created.work.type !== "ticket") {
    return context.json({ ok: true, ignored: true });
  }

  const work = event.data.work_created.work;
  console.info(JSON.stringify({
    event: "devrev_webhook_received",
    integrationAccountId: accountId.data,
    ticketId: work.id,
  }));
  const slug = typeof account.metadata.organizationSlug === "string"
    ? account.metadata.organizationSlug
    : null;
  const sourceUrl = devrevTicketUrl(slug, work.display_id);
  const matches = await findAutomationsForDevRevTicket(accountId.data);
  try {
    await Promise.all(
      matches.map((match) =>
        queueAutomationRun({
          automationId: match.automationId,
          trigger: {
            attributes: {
              displayId: work.display_id,
              integrationAccountId: accountId.data,
              severity: work.severity ?? null,
              ticketId: work.id,
            },
            body: devrevTicketBody(work),
            // DevRev retries a failed delivery, and a ticket is created once.
            externalEventId: `${accountId.data}:${work.id}`,
            provider: "devrev",
            ...(sourceUrl ? { sourceUrl } : {}),
            title: devrevTicketTitle(work),
          },
        })
      ),
    );
  } catch (error) {
    console.error("Unable to fan out DevRev ticket", error);
    return context.json({ error: "Unable to start DevRev automation" }, 502);
  }

  return context.json({ ok: true, matchedAutomations: matches.length });
});
