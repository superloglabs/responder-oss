import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { findAgentsForDash0Alert } from "../../../../packages/core/src/db/agents.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { parseDash0Credentials } from "../../../../packages/core/src/integrations/dash0.js";
import { queueInvestigation } from "../investigations/queue.js";

const dash0AnyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
  })
  .passthrough();

const dash0KeyValueSchema = z.object({
  key: z.string().min(1),
  value: dash0AnyValueSchema,
});

const dash0CheckRuleSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().optional(),
    name: z.string().min(1).optional(),
    expression: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    url: z.string().url().optional(),
  })
  .passthrough();

const dash0WebhookSchema = z.object({
  type: z.enum([
    "alert.ongoing",
    "alert.resolved",
    "alert.superseded",
    "alert.closed",
  ]),
  data: z.object({
    issue: z
      .object({
        id: z.string().min(1),
        issueIdentifier: z.union([z.string(), z.number()]).transform(String),
        dataset: z.string().min(1),
        start: z.string().optional(),
        status: z.string().optional(),
        summary: z.string().min(1),
        description: z.string().optional(),
        labels: z.array(dash0KeyValueSchema).optional(),
        annotations: z.array(dash0KeyValueSchema).optional(),
        checkrules: z.array(dash0CheckRuleSchema).default([]),
        url: z.string().url().optional(),
      })
      .passthrough(),
  }),
});

type Dash0Issue = z.infer<typeof dash0WebhookSchema>["data"]["issue"];

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyDash0WebhookAuthorization(input: {
  authorization: string | undefined;
  webhookSecret: string;
}): boolean {
  const prefix = "Bearer ";
  if (!input.authorization?.startsWith(prefix)) return false;
  return safeEqual(input.authorization.slice(prefix.length), input.webhookSecret);
}

export function dash0IssueBody(issue: Dash0Issue): string {
  return JSON.stringify(issue, null, 2).slice(0, 100_000);
}

export const dash0WebhookRoutes = new Hono().post("/:accountId", async (context) => {
  const accountId = z.uuid().safeParse(context.req.param("accountId"));
  if (!accountId.success) {
    return context.json({ error: "Invalid Dash0 webhook authorization" }, 401);
  }
  const account = await getConnectedIntegrationAccountCredential({
    integrationAccountId: accountId.data,
    provider: "dash0",
  });
  if (!account?.encryptedCredentials) {
    return context.json({ error: "Invalid Dash0 webhook authorization" }, 401);
  }

  let webhookSecret: string;
  try {
    webhookSecret = parseDash0Credentials(
      decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
    ).webhookSecret;
  } catch {
    return context.json({ error: "Invalid Dash0 webhook authorization" }, 401);
  }
  if (
    !verifyDash0WebhookAuthorization({
      authorization: context.req.header("authorization"),
      webhookSecret,
    })
  ) {
    return context.json({ error: "Invalid Dash0 webhook authorization" }, 401);
  }

  const parsed = dash0WebhookSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) return context.json({ ok: true, ignored: true });
  if (parsed.data.type !== "alert.ongoing") {
    return context.json({ ok: true, ignored: true });
  }

  const issue = parsed.data.data.issue;
  const matches = await findAgentsForDash0Alert(accountId.data);
  try {
    await Promise.all(
      matches.map(async (match) => {
        const result = await queueInvestigation({
          agentId: match.agentId,
          provider: "dash0",
          externalEventId: `${accountId.data}:${issue.id}:${match.agentId}`,
          title: (issue.checkrules[0]?.name ?? issue.summary).slice(0, 500),
          body: dash0IssueBody(issue),
          sourceUrl: issue.url ?? issue.checkrules[0]?.url,
          attributes: {
            accountId: accountId.data,
            dataset: issue.dataset,
            issueId: issue.id,
            issueIdentifier: issue.issueIdentifier,
            status: issue.status ?? null,
            timestamp: issue.start ?? null,
          },
        });
        if (result.kind === "blocked") {
          throw new Error("Monthly investigation allowance exhausted");
        }
      }),
    );
  } catch (error) {
    console.error("Unable to fan out Dash0 alert", error);
    return context.json({ error: "Unable to start Dash0 investigation" }, 502);
  }

  return context.json({ ok: true, matchedAgents: matches.length });
});
