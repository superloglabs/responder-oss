import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { findAutomationsForSignozAlert } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { signozWebhookSecret } from "../../../../packages/core/src/integrations/signoz.js";
import { queueAutomationRun } from "../automations/queue.js";

const labelsSchema = z.record(z.string(), z.string()).catch({});

// SigNoz webhook channels send Alertmanager's webhook body. One delivery can
// carry several alerts of one rule, firing and resolved.
const signozAlertSchema = z.object({
  status: z.string(),
  labels: labelsSchema,
  annotations: labelsSchema,
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().min(1),
});

const signozNotificationSchema = z.object({
  alerts: z.array(signozAlertSchema).min(1),
  commonLabels: labelsSchema.optional(),
  externalURL: z.string().optional(),
  groupLabels: labelsSchema.optional(),
  receiver: z.string().optional(),
  status: z.string().optional(),
});

type SignozAlert = z.infer<typeof signozAlertSchema>;

// Alertmanager repeats a group's firing alerts on every notification. Each
// alert starts at most one run, so this only bounds a single delivery.
const maxAlertsPerDelivery = 20;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

// The channel sends the secret as a bearer token when its username is empty,
// and as the basic auth password when a member also fills in a username.
export function verifySignozWebhookAuthorization(input: {
  authorization: string | undefined;
  integrationAccountId: string;
}): boolean {
  const authorization = input.authorization ?? "";
  const secret = signozWebhookSecret(input.integrationAccountId);
  const bearer = /^Bearer (.+)$/u.exec(authorization);
  if (bearer) return safeEqual(bearer[1]!, secret);
  const basic = /^Basic ([A-Za-z0-9+/=]+)$/u.exec(authorization);
  if (!basic) return false;
  const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator >= 0 && safeEqual(decoded.slice(separator + 1), secret);
}

function signozAlertTitle(alert: SignozAlert): string {
  const name = alert.labels.alertname?.trim() || "SigNoz alert";
  const summary = alert.annotations.summary?.trim();
  return (summary ? `${name}: ${summary}` : name).slice(0, 500);
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

export const signozWebhookRoutes = new Hono().post("/:accountId", async (context) => {
  const accountId = z.uuid().safeParse(context.req.param("accountId"));
  if (!accountId.success) {
    return context.json({ error: "Invalid SigNoz webhook authorization" }, 401);
  }
  const account = await getConnectedIntegrationAccountCredential({
    integrationAccountId: accountId.data,
    provider: "signoz",
  });
  if (
    !account ||
    !verifySignozWebhookAuthorization({
      authorization: context.req.header("authorization"),
      integrationAccountId: accountId.data,
    })
  ) {
    console.warn(
      JSON.stringify({
        event: "signoz_webhook_rejected",
        integrationAccountId: accountId.data,
        reason: account ? "invalid_authorization" : "connection_not_found",
      }),
    );
    return context.json({ error: "Invalid SigNoz webhook authorization" }, 401);
  }

  const parsed = signozNotificationSchema.safeParse(parseJson(await context.req.text()));
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: "signoz_webhook_rejected",
        integrationAccountId: accountId.data,
        reason: "invalid_payload",
      }),
    );
    return context.json({ error: "Invalid SigNoz alert payload" }, 400);
  }

  // Resolved alerts are reported too. Only a firing alert starts a run.
  const firing = parsed.data.alerts.filter((alert) => alert.status === "firing");
  const alerts = firing.slice(0, maxAlertsPerDelivery);
  console.info(
    JSON.stringify({
      alerts: parsed.data.alerts.length,
      dropped: firing.length - alerts.length,
      event: "signoz_webhook_received",
      firing: firing.length,
      integrationAccountId: accountId.data,
    }),
  );
  if (!alerts.length) return context.json({ ok: true, ignored: true });

  const matches = await findAutomationsForSignozAlert(accountId.data);
  try {
    await Promise.all(
      alerts.flatMap((alert) => {
        const sourceUrl = httpsUrl(alert.generatorURL);
        return matches.map((match) =>
          queueAutomationRun({
            automationId: match.automationId,
            trigger: {
              attributes: {
                alertName: alert.labels.alertname ?? null,
                fingerprint: alert.fingerprint,
                integrationAccountId: accountId.data,
                ruleId: alert.labels.ruleId ?? null,
                severity: alert.labels.severity ?? null,
                startsAt: alert.startsAt,
                status: alert.status,
              },
              body: JSON.stringify({
                ...alert,
                externalURL: parsed.data.externalURL,
                groupLabels: parsed.data.groupLabels,
              }, null, 2).slice(0, 100_000),
              // Alertmanager sends a firing alert again until it resolves.
              // The fingerprint and start time name one occurrence.
              externalEventId: `${accountId.data}:${alert.fingerprint}:${alert.startsAt}`,
              provider: "signoz",
              ...(sourceUrl ? { sourceUrl } : {}),
              title: signozAlertTitle(alert),
            },
          })
        );
      }),
    );
  } catch (error) {
    console.error("Unable to fan out SigNoz alert", error);
    return context.json({ error: "Unable to start SigNoz automation" }, 502);
  }

  return context.json({ ok: true, matchedAutomations: matches.length, startedAlerts: alerts.length });
});
