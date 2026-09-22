import { z } from "zod";
import type { RuntimeSentryConnection } from "@responder/core/db/investigations";

const sentryIssueSchema = z.object({
  count: z.union([z.string(), z.number()]).optional(),
  culprit: z.string().nullable().optional(),
  firstSeen: z.string().optional(),
  id: z.union([z.string(), z.number()]),
  isUnhandled: z.boolean().optional(),
  issueCategory: z.string().optional(),
  issueType: z.string().optional(),
  lastSeen: z.string().optional(),
  latestEvent: z.object({
    culprit: z.string().nullable().optional(),
    dateCreated: z.string().optional(),
    eventID: z.string().optional(),
    message: z.string().optional(),
    platform: z.string().nullable().optional(),
    title: z.string().optional(),
  }).passthrough().optional(),
  level: z.string().nullable().optional(),
  permalink: z.string().url().optional(),
  platform: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  project: z.object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    platform: z.string().nullable().optional(),
    slug: z.string().optional(),
  }).passthrough().optional(),
  shortId: z.string().optional(),
  status: z.string().optional(),
  substatus: z.string().nullable().optional(),
  title: z.string().optional(),
  userCount: z.number().optional(),
}).passthrough();

export interface SentryIssueLocator {
  apiBaseUrl: "https://sentry.io" | "https://us.sentry.io" | "https://de.sentry.io";
  issueId: string;
}

export interface SentryIssueTriageContext {
  count?: string;
  culprit?: string;
  firstSeen?: string;
  id: string;
  isUnhandled?: boolean;
  issueCategory?: string;
  issueType?: string;
  lastSeen?: string;
  latestEvent?: {
    culprit?: string;
    dateCreated?: string;
    eventId?: string;
    message?: string;
    platform?: string;
    title?: string;
  };
  level?: string;
  permalink?: string;
  platform?: string;
  priority?: string;
  project?: {
    id?: string;
    name?: string;
    platform?: string;
    slug?: string;
  };
  shortId?: string;
  status?: string;
  substatus?: string;
  title?: string;
  userCount?: number;
}

function boundedText(value: string | null | undefined, limit: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

function definedEntries<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function sentryIssueLocator(body: string): SentryIssueLocator | null {
  const urls = body.match(/https:\/\/[^\s>|)]+/giu) ?? [];
  for (const candidate of urls) {
    let url: URL;
    try {
      url = new URL(candidate.replace(/[.,;:!?]+$/u, ""));
    } catch {
      continue;
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "sentry.io" && !hostname.endsWith(".sentry.io")) {
      continue;
    }
    const match = url.pathname.match(/\/issues\/([^/]+)/iu);
    const issueId = match?.[1];
    if (!issueId || !/^[a-z0-9_-]{1,128}$/iu.test(issueId)) continue;
    const apiBaseUrl = hostname === "de.sentry.io"
      ? "https://de.sentry.io"
      : hostname === "us.sentry.io"
        ? "https://us.sentry.io"
        : "https://sentry.io";
    return { apiBaseUrl, issueId };
  }
  return null;
}

export async function fetchSentryIssueTriageContext(
  input: {
    alertBody: string;
    connection: RuntimeSentryConnection;
  },
  request: typeof fetch = globalThis.fetch,
): Promise<SentryIssueTriageContext | null> {
  const locator = sentryIssueLocator(input.alertBody);
  if (!locator) return null;
  const url = new URL(
    `/api/0/organizations/${encodeURIComponent(input.connection.organizationSlug)}/issues/${encodeURIComponent(locator.issueId)}/`,
    locator.apiBaseUrl,
  );
  const response = await request(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.connection.accessToken}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Sentry issue request failed (status=${response.status})`);
  }
  const parsedIssue = sentryIssueSchema.safeParse(await response.json());
  if (!parsedIssue.success) return null;
  const issue = parsedIssue.data;
  const latestEvent = issue.latestEvent
    ? definedEntries({
        culprit: boundedText(issue.latestEvent.culprit, 1_000),
        dateCreated: boundedText(issue.latestEvent.dateCreated, 100),
        eventId: boundedText(issue.latestEvent.eventID, 128),
        message: boundedText(issue.latestEvent.message, 2_000),
        platform: boundedText(issue.latestEvent.platform, 100),
        title: boundedText(issue.latestEvent.title, 500),
      })
    : undefined;
  const project = issue.project
    ? definedEntries({
        id: issue.project.id === undefined ? undefined : String(issue.project.id),
        name: boundedText(issue.project.name, 200),
        platform: boundedText(issue.project.platform, 100),
        slug: boundedText(issue.project.slug, 200),
      })
    : undefined;
  return definedEntries({
    count: issue.count === undefined ? undefined : String(issue.count),
    culprit: boundedText(issue.culprit, 1_000),
    firstSeen: boundedText(issue.firstSeen, 100),
    id: String(issue.id),
    isUnhandled: issue.isUnhandled,
    issueCategory: boundedText(issue.issueCategory, 100),
    issueType: boundedText(issue.issueType, 100),
    lastSeen: boundedText(issue.lastSeen, 100),
    latestEvent,
    level: boundedText(issue.level, 100),
    permalink: boundedText(issue.permalink, 2_000),
    platform: boundedText(issue.platform, 100),
    priority: boundedText(issue.priority, 100),
    project,
    shortId: boundedText(issue.shortId, 200),
    status: boundedText(issue.status, 100),
    substatus: boundedText(issue.substatus, 100),
    title: boundedText(issue.title, 500),
    userCount: issue.userCount,
  });
}
