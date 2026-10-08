import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AutomationTrigger } from "../../../../packages/core/src/automations/config.js";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  listSlackMessageAuthors,
  type AutomationTriggerInput,
} from "../../../../packages/core/src/db/automations.js";
import {
  getConnectedOrganizationIntegrationAccount,
  getIntegrationResourceNames,
} from "../../../../packages/core/src/db/integrations.js";
import { SlackApiError } from "../../../../packages/core/src/integrations/slack.js";
import { slackTimestampPattern } from "../../../../packages/core/src/integrations/slack-history.js";
import {
  getSentryIssue,
  getSentryIssueEventEnvironment,
  listSentryIssues,
} from "../integrations/sentry.js";
import {
  getFreshSentryCredentials,
  getSentryOrganizationSlug,
} from "../integrations/sentry-credentials.js";
import { sentryAutomationTrigger, sentryIssueSchema } from "../webhooks/sentry.js";
import {
  isSupportedSlackMessageSubtype,
  slackAutomationTrigger,
  slackEventAuthor,
  slackMessageBody,
  slackMessageSchema,
  slackMessageTitle,
} from "../webhooks/slack.js";

// Past Slack messages and Sentry issues that an automation's triggers would
// have started a run on. A member picks one to start an example run.

type SlackTrigger = Extract<AutomationTrigger, { kind: "slack" }>;
type SentryTrigger = Extract<AutomationTrigger, { kind: "sentry" }>;

export type AutomationExampleEvent =
  | {
      authorName: string | null;
      channelId: string;
      channelName: string | null;
      integrationAccountId: string;
      kind: "slack";
      occurredAt: string;
      timestamp: string;
      title: string;
    }
  | {
      integrationAccountId: string;
      issueId: string;
      kind: "sentry";
      level: string | null;
      occurredAt: string | null;
      projectName: string | null;
      shortId: string | null;
      title: string;
    };

export const automationExampleSchema = z.discriminatedUnion("kind", [
  z.object({
    channelId: z.string().min(1).max(255),
    integrationAccountId: z.uuid(),
    kind: z.literal("slack"),
    timestamp: z.string().regex(slackTimestampPattern),
  }),
  z.object({
    integrationAccountId: z.uuid(),
    issueId: z.string().regex(/^\d{1,20}$/u),
    kind: z.literal("sentry"),
  }),
]);

export type AutomationExample = z.infer<typeof automationExampleSchema>;

export class AutomationExampleError extends Error {
  constructor(message: string, readonly status: 404 | 502) {
    super(message);
    this.name = "AutomationExampleError";
  }
}

// Messages read from each channel, and channels read per trigger.
const slackMessagesPerChannel = 20;
const slackChannelsPerTrigger = 10;
const sentryIssuesPerTrigger = 20;
// Events listed in all.
const maximumExamples = 30;

export interface ExampleEventDependencies {
  getAccount: typeof getConnectedOrganizationIntegrationAccount;
  getEnvironment: typeof getSentryIssueEventEnvironment;
  getResourceNames: typeof getIntegrationResourceNames;
  getSentryCredentials: typeof getFreshSentryCredentials;
  getSentryIssue: typeof getSentryIssue;
  listSentryIssues: typeof listSentryIssues;
  listSlackAuthors: typeof listSlackMessageAuthors;
  readSlackMessages: typeof readSlackMessages;
}

export const defaultExampleEventDependencies: ExampleEventDependencies = {
  getAccount: getConnectedOrganizationIntegrationAccount,
  getEnvironment: getSentryIssueEventEnvironment,
  getResourceNames: getIntegrationResourceNames,
  getSentryCredentials: getFreshSentryCredentials,
  getSentryIssue,
  listSentryIssues,
  listSlackAuthors: listSlackMessageAuthors,
  readSlackMessages,
};

const slackHistorySchema = z.object({
  messages: z.array(z.record(z.string(), z.unknown())),
  ok: z.literal(true),
});

// A channel's newest top-level messages as Slack sends them, or the one
// message at `timestamp`.
export async function readSlackMessages(input: {
  accessToken: string;
  channelId: string;
  limit: number;
  timestamp?: string;
}): Promise<Array<Record<string, unknown>>> {
  const url = new URL("https://slack.com/api/conversations.history");
  url.searchParams.set("channel", input.channelId);
  url.searchParams.set("limit", String(input.limit));
  if (input.timestamp) {
    url.searchParams.set("latest", input.timestamp);
    url.searchParams.set("oldest", input.timestamp);
    url.searchParams.set("inclusive", "true");
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${input.accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  const page = slackHistorySchema.safeParse(payload);
  if (!response.ok || !page.success) {
    const error = z.object({ error: z.string() }).safeParse(payload);
    throw new SlackApiError("conversations.history", error.success ? error.data.error : `http_${response.status}`);
  }
  return page.data.messages;
}

async function slackAccount(
  organizationId: string,
  integrationAccountId: string,
  dependencies: ExampleEventDependencies,
) {
  const account = await dependencies.getAccount({
    integrationAccountId,
    organizationId,
    provider: "slack",
  });
  if (!account?.encryptedCredentials) return null;
  const accessToken = decryptCredentials<Record<string, unknown>>(account.encryptedCredentials).accessToken;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const { appId, botUserId } = account.metadata;
  return {
    accessToken,
    appId: typeof appId === "string" ? appId : null,
    botUserId: typeof botUserId === "string" ? botUserId : null,
    teamId: account.externalAccountId,
  };
}

// A message the trigger would start a run on, as the webhook reads it.
function slackTriggerMessage(
  raw: Record<string, unknown>,
  channelId: string,
  trigger: SlackTrigger,
  account: { appId: string | null; botUserId: string | null },
) {
  const parsed = slackMessageSchema.safeParse({ ...raw, channel: channelId, type: "message" });
  if (!parsed.success || !isSupportedSlackMessageSubtype(parsed.data.subtype)) return null;
  const message = parsed.data;
  const author = slackEventAuthor(message);
  const authorIds = author?.ids ?? [];
  if (
    (account.botUserId && authorIds.includes(account.botUserId)) ||
    (account.appId && authorIds.includes(account.appId)) ||
    trigger.ignoredAuthors?.some((ignored) => authorIds.includes(ignored.id)) ||
    (trigger.includedAuthors && !trigger.includedAuthors.some((included) => authorIds.includes(included.id)))
  ) {
    return null;
  }
  return { author, message };
}

async function slackExamples(
  organizationId: string,
  trigger: SlackTrigger,
  dependencies: ExampleEventDependencies,
): Promise<AutomationExampleEvent[]> {
  const account = await slackAccount(organizationId, trigger.integrationAccountId, dependencies);
  if (!account) return [];
  const channelIds = trigger.channelIds.slice(0, slackChannelsPerTrigger);
  const [channelNames, authors, channels] = await Promise.all([
    dependencies.getResourceNames({
      externalIds: channelIds,
      integrationAccountId: trigger.integrationAccountId,
      kind: "slack_channel",
      organizationId,
    }),
    dependencies.listSlackAuthors({
      channelIds,
      integrationAccountId: trigger.integrationAccountId,
      organizationId,
    }),
    Promise.all(channelIds.map(async (channelId) => ({
      channelId,
      messages: await dependencies.readSlackMessages({
        accessToken: account.accessToken,
        channelId,
        limit: slackMessagesPerChannel,
      }),
    }))),
  ]);
  const authorNames = new Map(authors.map((author) => [author.id, author.name]));
  return channels.flatMap(({ channelId, messages }) => messages.flatMap((raw) => {
    const match = slackTriggerMessage(raw, channelId, trigger, account);
    if (!match) return [];
    const { author, message } = match;
    return [{
      authorName: author?.name ?? (author ? authorNames.get(author.id) ?? null : null),
      channelId,
      channelName: channelNames.get(channelId) ?? null,
      integrationAccountId: trigger.integrationAccountId,
      kind: "slack" as const,
      occurredAt: new Date(Number(message.ts) * 1_000).toISOString(),
      timestamp: message.ts,
      title: slackMessageTitle(slackMessageBody(message)),
    }];
  }));
}

async function sentryAccount(
  organizationId: string,
  integrationAccountId: string,
  dependencies: ExampleEventDependencies,
) {
  const account = await dependencies.getAccount({
    integrationAccountId,
    organizationId,
    provider: "sentry",
  });
  if (!account) return null;
  const { credentials } = await dependencies.getSentryCredentials({
    accountId: integrationAccountId,
    organizationId,
  });
  return {
    accessToken: credentials.accessToken,
    installationId: credentials.installationId,
    organizationSlug: getSentryOrganizationSlug(account.metadata),
  };
}

async function sentryExamples(
  organizationId: string,
  trigger: SentryTrigger,
  dependencies: ExampleEventDependencies,
): Promise<AutomationExampleEvent[]> {
  const account = await sentryAccount(organizationId, trigger.integrationAccountId, dependencies);
  if (!account) return [];
  const issues = z.array(z.unknown()).parse(await dependencies.listSentryIssues({
    accessToken: account.accessToken,
    limit: sentryIssuesPerTrigger,
    organizationSlug: account.organizationSlug,
    projectIds: trigger.projectIds,
  }));
  return issues.flatMap((value) => {
    const issue = sentryIssueSchema.safeParse(value);
    if (!issue.success || !trigger.projectIds.includes(issue.data.project.id)) return [];
    return [{
      integrationAccountId: trigger.integrationAccountId,
      issueId: issue.data.id,
      kind: "sentry" as const,
      level: issue.data.level ?? null,
      occurredAt: issue.data.lastSeen ?? issue.data.firstSeen ?? null,
      projectName: issue.data.project.name ?? issue.data.project.slug ?? null,
      shortId: issue.data.shortId ?? null,
      title: issue.data.title,
    }];
  });
}

function exampleKey(example: AutomationExampleEvent): string {
  return example.kind === "slack"
    ? `slack:${example.integrationAccountId}:${example.channelId}:${example.timestamp}`
    : `sentry:${example.integrationAccountId}:${example.issueId}`;
}

// The newest past events across the Slack and Sentry triggers. A trigger
// whose provider cannot be read is left out; when none can be, this throws.
export async function listAutomationExampleEvents(
  organizationId: string,
  triggers: AutomationTrigger[],
  dependencies: ExampleEventDependencies = defaultExampleEventDependencies,
): Promise<AutomationExampleEvent[]> {
  const readable = triggers.filter((trigger): trigger is SlackTrigger | SentryTrigger =>
    trigger.kind === "slack" || trigger.kind === "sentry"
  );
  const results = await Promise.allSettled(readable.map((trigger) =>
    trigger.kind === "slack"
      ? slackExamples(organizationId, trigger, dependencies)
      : sentryExamples(organizationId, trigger, dependencies)
  ));
  const failures = results.filter((result) => result.status === "rejected");
  for (const failure of failures) {
    console.warn(JSON.stringify({
      errorCode: failure.reason instanceof Error ? failure.reason.name : typeof failure.reason,
      event: "automation_example_events_unavailable",
      message: failure.reason instanceof SlackApiError ? failure.reason.message : undefined,
    }));
  }
  if (results.length > 0 && failures.length === results.length) {
    throw new AutomationExampleError("Unable to load past events. Try again.", 502);
  }
  const examples = new Map<string, AutomationExampleEvent>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const example of result.value) examples.set(exampleKey(example), example);
  }
  return [...examples.values()]
    .sort((left, right) => (right.occurredAt ?? "").localeCompare(left.occurredAt ?? ""))
    .slice(0, maximumExamples);
}

function markExample(trigger: AutomationTriggerInput): AutomationTriggerInput {
  return { ...trigger, attributes: { ...trigger.attributes, example: true } };
}

// The trigger a live run on the past event would have received, marked as an
// example. The event is read again from its provider, so a member can only
// replay what the automation's triggers watch.
export async function exampleAutomationTrigger(
  organizationId: string,
  triggers: AutomationTrigger[],
  example: AutomationExample,
  dependencies: ExampleEventDependencies = defaultExampleEventDependencies,
): Promise<AutomationTriggerInput> {
  const externalEventId = `example:${randomUUID()}`;
  if (example.kind === "slack") {
    const trigger = triggers.find((candidate): candidate is SlackTrigger =>
      candidate.kind === "slack" &&
      candidate.integrationAccountId === example.integrationAccountId &&
      candidate.channelIds.includes(example.channelId)
    );
    if (!trigger) throw new AutomationExampleError("This channel is not in the automation's Slack triggers.", 404);
    const account = await slackAccount(organizationId, trigger.integrationAccountId, dependencies);
    if (!account) throw new AutomationExampleError("Slack connection not found", 404);
    const messages = await dependencies.readSlackMessages({
      accessToken: account.accessToken,
      channelId: example.channelId,
      limit: 1,
      timestamp: example.timestamp,
    }).catch(() => {
      throw new AutomationExampleError("Unable to read the Slack message. Try again.", 502);
    });
    const raw = messages.find((message) => message.ts === example.timestamp);
    const match = raw ? slackTriggerMessage(raw, example.channelId, trigger, account) : null;
    if (!match) throw new AutomationExampleError("Slack message not found", 404);
    const { author, message } = match;
    const rawBody = slackMessageBody(message);
    // A trigger on mentions starts on an app mention, whose leading mention
    // the run does not receive.
    const mentionsOnly = trigger.eventMode === "mentions";
    const body = mentionsOnly
      ? rawBody.replace(/^\s*<@[A-Z0-9]+>\s*/iu, "").trim() || rawBody
      : rawBody;
    return markExample(slackAutomationTrigger({
      author,
      body,
      channelId: example.channelId,
      externalEventId,
      mentioned: mentionsOnly || (account.botUserId !== null && rawBody.includes(`<@${account.botUserId}>`)),
      teamId: account.teamId,
      threadTimestamp: message.thread_ts,
      timestamp: message.ts,
    }));
  }
  const candidates = triggers.filter((candidate): candidate is SentryTrigger =>
    candidate.kind === "sentry" && candidate.integrationAccountId === example.integrationAccountId
  );
  if (candidates.length === 0) throw new AutomationExampleError("This Sentry connection is not in the automation's triggers.", 404);
  const account = await sentryAccount(organizationId, example.integrationAccountId, dependencies).catch(() => {
    throw new AutomationExampleError("Unable to reach Sentry. Try again.", 502);
  });
  if (!account) throw new AutomationExampleError("Sentry connection not found", 404);
  const value = await dependencies.getSentryIssue({
    accessToken: account.accessToken,
    issueId: example.issueId,
    organizationSlug: account.organizationSlug,
  }).catch(() => {
    throw new AutomationExampleError("Unable to read the Sentry issue. Try again.", 502);
  });
  const issue = sentryIssueSchema.safeParse(value);
  const trigger = issue.success
    ? candidates.find((candidate) => candidate.projectIds.includes(issue.data.project.id))
    : undefined;
  if (!issue.success || !trigger) throw new AutomationExampleError("Sentry issue not found", 404);
  // A trigger on new issues sees the issue as created, else as regressed.
  const action = trigger.eventTypes.includes("new_issue") ? "created" : "unresolved";
  // Live runs read the environment only for triggers that exclude some.
  const environment = trigger.excludedEnvironments?.length
    ? await dependencies.getEnvironment({
        accessToken: account.accessToken,
        event: action === "created" ? "oldest" : "latest",
        issueId: issue.data.id,
        organizationSlug: account.organizationSlug,
      }).catch(() => undefined)
    : undefined;
  return markExample(sentryAutomationTrigger({
    action,
    environment,
    externalEventId,
    installationId: account.installationId,
    issue: issue.data,
  }));
}
