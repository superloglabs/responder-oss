import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { findAgentsForSentryIssue } from "../../../../packages/core/src/db/agents.js";
import { findAutomationsForSentryIssue } from "../../../../packages/core/src/db/automations.js";
import { queueInvestigation } from "../investigations/queue.js";
import { queueAutomationRun } from "../automations/queue.js";
import { getSentryIssueEventEnvironment } from "../integrations/sentry.js";
import {
  getFreshSentryCredentials,
  getSentryOrganizationSlug,
} from "../integrations/sentry-credentials.js";
import { getOrganizationIntegrationAccount } from "../../../../packages/core/src/db/integrations.js";

const sentryIssueSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    shortId: z.string().optional(),
    title: z.string().min(1),
    culprit: z.string().optional(),
    level: z.string().optional(),
    status: z.string().optional(),
    substatus: z.string().nullable().optional(),
    web_url: z.string().url().optional(),
    permalink: z.string().url().optional(),
    platform: z.string().nullable().optional(),
    project: z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string().optional(),
      slug: z.string().optional(),
      platform: z.string().nullable().optional(),
    }),
    metadata: z.record(z.string(), z.unknown()).optional(),
    issueType: z.string().optional(),
    issueCategory: z.string().optional(),
    priority: z.string().nullable().optional(),
    isUnhandled: z.boolean().optional(),
    count: z.union([z.string(), z.number()]).optional(),
    userCount: z.number().optional(),
    firstSeen: z.string().optional(),
    lastSeen: z.string().optional(),
  })
  .passthrough();

const sentryIssueWebhookSchema = z.object({
  action: z.enum(["created", "unresolved"]),
  installation: z.object({ uuid: z.uuid() }),
  data: z.object({ issue: sentryIssueSchema }),
  actor: z.unknown().optional(),
});

const investigationStartResponseSchema = z.object({
  duplicate: z.boolean(),
  investigationId: z.uuid(),
});

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifySentrySignature(input: {
  rawBody: string;
  signature: string | undefined;
  clientSecret?: string;
}): boolean {
  const clientSecret = input.clientSecret ?? process.env.SENTRY_CLIENT_SECRET;
  if (!clientSecret || !input.signature) return false;
  const digest = createHmac("sha256", clientSecret)
    .update(input.rawBody, "utf8")
    .digest("hex");
  return safeEqual(digest, input.signature);
}

type SentryIssue = z.infer<typeof sentryIssueSchema>;
type SentryIssueAction = z.infer<typeof sentryIssueWebhookSchema>["action"];

export function sentryIssueBody(
  issue: SentryIssue,
  environment?: string | null,
): string {
  return JSON.stringify(
    {
      shortId: issue.shortId ?? null,
      ...(environment === undefined ? {} : { environment }),
      title: issue.title,
      culprit: issue.culprit ?? null,
      level: issue.level ?? null,
      status: issue.status ?? null,
      substatus: issue.substatus ?? null,
      platform: issue.platform ?? issue.project.platform ?? null,
      project: issue.project,
      issueType: issue.issueType ?? null,
      issueCategory: issue.issueCategory ?? null,
      priority: issue.priority ?? null,
      isUnhandled: issue.isUnhandled ?? null,
      count: issue.count ?? null,
      userCount: issue.userCount ?? null,
      firstSeen: issue.firstSeen ?? null,
      lastSeen: issue.lastSeen ?? null,
      metadata: issue.metadata ?? {},
    },
    null,
    2,
  ).slice(0, 100_000);
}

async function forwardSentryIssue(input: {
  action: SentryIssueAction;
  agentId: string;
  installationId: string;
  issue: SentryIssue;
  payloadHash: string;
  requestId?: string;
}) {
  const sourceUrl = input.issue.web_url ?? input.issue.permalink;
  const occurrence = input.issue.lastSeen
    ? createHash("sha256").update(input.issue.lastSeen, "utf8").digest("hex")
    : input.payloadHash;
  const externalEventId =
    input.action === "created"
      ? `${input.installationId}:${input.issue.id}:${input.agentId}`
      : `${input.installationId}:${input.issue.id}:${input.action}:${occurrence}:${input.agentId}`;
  const result = await queueInvestigation({
    agentId: input.agentId,
    provider: "sentry",
    externalEventId,
    title: `${input.issue.shortId ?? input.issue.id}: ${input.issue.title}`.slice(
      0,
      500,
    ),
    body: sentryIssueBody(input.issue),
    sourceUrl,
    attributes: {
      action: input.action,
      installationId: input.installationId,
      issueId: input.issue.id,
      projectId: input.issue.project.id,
      projectName: input.issue.project.name ?? null,
      projectSlug: input.issue.project.slug ?? null,
      requestId: input.requestId ?? null,
      shortId: input.issue.shortId ?? null,
      timestamp: input.issue.lastSeen ?? input.issue.firstSeen ?? null,
    },
  });
  if (result.kind === "blocked") {
    throw new Error("Monthly investigation allowance exhausted");
  }
  return investigationStartResponseSchema.parse({
    duplicate: result.kind === "duplicate",
    investigationId: result.investigationId,
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// The environment of the event that fired the webhook: an issue's first
// event when it is created, and its latest event when it regresses. Returns
// null when the event has no environment and undefined when the lookup fails.
async function sentryIssueEnvironment(input: {
  action: SentryIssueAction;
  integrationAccountId: string;
  issueId: string;
  organizationId: string;
}): Promise<string | null | undefined> {
  try {
    const account = await getOrganizationIntegrationAccount({
      integrationAccountId: input.integrationAccountId,
      organizationId: input.organizationId,
      provider: "sentry",
    });
    if (!account) return undefined;
    const { credentials } = await getFreshSentryCredentials({
      accountId: input.integrationAccountId,
      organizationId: input.organizationId,
    });
    return await getSentryIssueEventEnvironment({
      accessToken: credentials.accessToken,
      event: input.action === "created" ? "oldest" : "latest",
      issueId: input.issueId,
      organizationSlug: getSentryOrganizationSlug(account.metadata),
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        event: "sentry_issue_environment_unavailable",
        integrationAccountId: input.integrationAccountId,
        issueId: input.issueId,
      }),
    );
    return undefined;
  }
}

// Starts each automation unless every matching trigger excludes the issue's
// environment. When the environment cannot be read, the automation runs, so
// a Sentry outage does not hide a production issue.
async function queueEnvironmentFilteredAutomations(input: {
  action: SentryIssueAction;
  automations: Awaited<ReturnType<typeof findAutomationsForSentryIssue>>;
  issueId: string;
  queueAutomation: (
    automationId: string,
    environment?: string | null,
  ) => Promise<unknown>;
}): Promise<void> {
  const environments = new Map<string, Promise<string | null | undefined>>();
  await Promise.all(input.automations.map(async (match) => {
    let environment = environments.get(match.integrationAccountId);
    if (!environment) {
      environment = sentryIssueEnvironment({
        action: input.action,
        integrationAccountId: match.integrationAccountId,
        issueId: input.issueId,
        organizationId: match.organizationId,
      });
      environments.set(match.integrationAccountId, environment);
    }
    const resolved = await environment;
    if (resolved && match.excludedEnvironments.includes(resolved)) {
      console.info(
        JSON.stringify({
          automationId: match.automationId,
          environment: resolved,
          event: "sentry_automation_environment_skipped",
          issueId: input.issueId,
        }),
      );
      return;
    }
    try {
      await input.queueAutomation(match.automationId, resolved);
    } catch (error) {
      console.error("Unable to start environment-filtered Sentry automation", error);
    }
  }));
}

export const sentryWebhookRoutes = new Hono().post("/", async (context) => {
  const rawBody = await context.req.text();
  if (
    !verifySentrySignature({
      rawBody,
      signature: context.req.header("sentry-hook-signature"),
    })
  ) {
    console.warn(
      JSON.stringify({
        event: "sentry_webhook_rejected",
        reason: "invalid_signature",
      }),
    );
    return context.json({ error: "Invalid Sentry signature" }, 401);
  }

  if (context.req.header("sentry-hook-resource") !== "issue") {
    return context.json({ ok: true, ignored: true });
  }

  const parsed = sentryIssueWebhookSchema.safeParse(
    parseJson(rawBody),
  );
  if (!parsed.success) {
    return context.json({ ok: true, ignored: true });
  }

  const { action } = parsed.data;
  const { issue } = parsed.data.data;
  const installationId = parsed.data.installation.uuid;
  const payloadHash = createHash("sha256")
    .update(rawBody, "utf8")
    .digest("hex");
  console.info(
    JSON.stringify({
      action: parsed.data.action,
      event: "sentry_webhook_received",
      installationId,
      issueId: issue.id,
      projectId: issue.project.id,
    }),
  );
  const matches = await findAgentsForSentryIssue({
    installationId,
    projectId: issue.project.id,
  });
  const automationMatches = await findAutomationsForSentryIssue({
    action,
    installationId,
    projectId: issue.project.id,
  });
  const automationOccurrence = issue.lastSeen
    ? createHash("sha256").update(issue.lastSeen, "utf8").digest("hex")
    : payloadHash;
  const queueAutomation = (automationId: string, environment?: string | null) =>
    queueAutomationRun({
      automationId,
      trigger: {
        attributes: {
          action,
          installationId,
          issueId: issue.id,
          projectId: issue.project.id,
          projectName: issue.project.name ?? null,
          projectSlug: issue.project.slug ?? null,
          ...(environment === undefined ? {} : { environment }),
        },
        body: sentryIssueBody(issue, environment),
        externalEventId: action === "created"
          ? `${installationId}:${issue.id}:${automationId}`
          : `${installationId}:${issue.id}:${action}:${automationOccurrence}:${automationId}`,
        provider: "sentry",
        sourceUrl: issue.web_url ?? issue.permalink,
        title: `${issue.shortId ?? issue.id}: ${issue.title}`.slice(0, 500),
      },
    });
  const filteredAutomations = automationMatches.filter((match) =>
    match.excludedEnvironments.length > 0
  );
  try {
    await Promise.all(
      [
        ...matches.map((match) =>
        forwardSentryIssue({
          action,
          agentId: match.agentId,
          installationId,
          issue,
          payloadHash,
          requestId: context.req.header("request-id"),
        })),
        ...automationMatches
          .filter((match) => match.excludedEnvironments.length === 0)
          .map((match) => queueAutomation(match.automationId)),
      ],
    );
  } catch (error) {
    console.error("Unable to fan out Sentry issue", error);
    return context.json({ error: "Unable to start Sentry investigation" }, 502);
  }
  // Sentry gives a webhook one second to respond, so environment-filtered
  // automations look up the environment after the response.
  if (filteredAutomations.length > 0) {
    void queueEnvironmentFilteredAutomations({
      action,
      automations: filteredAutomations,
      issueId: issue.id,
      queueAutomation,
    });
  }

  return context.json({
    ok: true,
    matchedAgents: matches.length,
    ...(automationMatches.length > 0
      ? { matchedAutomations: automationMatches.length }
      : {}),
  });
});
