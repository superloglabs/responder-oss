import { Hono } from "hono";
import { z } from "zod";
import {
  errorIssueDays,
  errorIssueEnvironments,
  errorIssueHours,
  errorIssueServices,
  errorIssueStatusCounts,
  findErrorIssue,
  listErrorIssues,
  setErrorIssueStatus,
} from "../../../../packages/core/src/db/error-issues.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { errorIssueStatuses } from "../../../../packages/core/src/telemetry/error-issues.js";
import { getActiveTenant } from "../tenant.js";

// Error issues: the workspace's telemetry exceptions grouped by fingerprint.
// They come with telemetry.
export type ErrorIssueRouteDependencies = {
  days: typeof errorIssueDays;
  environments: typeof errorIssueEnvironments;
  findIssue: typeof findErrorIssue;
  hasCapability: (organizationId: string, capability: "telemetry") => Promise<boolean>;
  hours: typeof errorIssueHours;
  listIssues: typeof listErrorIssues;
  now: () => Date;
  services: typeof errorIssueServices;
  setStatus: typeof setErrorIssueStatus;
  statusCounts: typeof errorIssueStatusCounts;
  tenant: (
    headers: Headers,
  ) => Promise<
    | { ok: true; organizationId: string; user: { id: string } }
    | { error: string; ok: false; status: 401 | 403 | 409 }
  >;
};

const defaultDependencies: ErrorIssueRouteDependencies = {
  days: errorIssueDays,
  environments: errorIssueEnvironments,
  findIssue: findErrorIssue,
  hasCapability: organizationHasCapability,
  hours: errorIssueHours,
  listIssues: listErrorIssues,
  now: () => new Date(),
  services: errorIssueServices,
  setStatus: setErrorIssueStatus,
  statusCounts: errorIssueStatusCounts,
  tenant: getActiveTenant,
};

// Issues per page, and the days of counts the list and an issue show.
export const errorIssuesPerPage = 50;
export const errorIssueListDays = 14;
export const errorIssueDetailDays = 30;

const idSchema = z.uuid();
const listQuerySchema = z.object({
  statuses: z.array(z.enum(errorIssueStatuses)).max(3).optional(),
  services: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  environments: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  activity: z.enum(["active", "inactive"]).optional(),
  range: z.enum(["24h", "7d", "14d", "30d", "all"]).optional(),
  before: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
  beforeFirstSeen: z.iso.datetime().optional(),
  beforeEvents: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(["lastSeen", "firstSeen", "events"]).optional(),
  search: z.string().trim().max(200).optional(),
  service: z.string().trim().min(1).max(200).optional(),
  status: z.enum([...errorIssueStatuses, "all"]).default("open"),
});
const statusSchema = z.object({ status: z.enum(errorIssueStatuses) });

// The start of the first of 24 UTC hours that end with the current hour.
export function firstHour(now: Date): string {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  return new Date(hour.getTime() - 23 * 3_600_000).toISOString();
}

// The first UTC day of a range of days that ends today.
export function firstDay(now: Date, days: number): string {
  return new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

export function createErrorIssueRoutes(dependencies: ErrorIssueRouteDependencies = defaultDependencies) {
  async function access(headers: Headers): Promise<
    | { ok: true; organizationId: string }
    | { error: string; ok: false; status: 401 | 403 | 404 | 409 }
  > {
    const tenant = await dependencies.tenant(headers);
    if (tenant.ok === false) return { error: tenant.error, ok: false, status: tenant.status };
    if (!(await dependencies.hasCapability(tenant.organizationId, "telemetry"))) {
      return { error: "Errors are not available", ok: false, status: 404 };
    }
    return { ok: true, organizationId: tenant.organizationId };
  }

  return new Hono()
    .get("/", async (context) => {
      const tenant = await access(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      const query = listQuerySchema.safeParse({
        ...context.req.query(),
        ...Object.fromEntries(["statuses", "services", "environments"].flatMap((key) => {
          const values = context.req.queries(key);
          return values?.length ? [[key, values]] : [];
        })),
      });
      if (!query.success) return context.json({ error: "Invalid filter" }, 400);
      const { before, beforeId, search, service, status, sort, beforeFirstSeen, beforeEvents } = query.data;
      if (Boolean(before) !== Boolean(beforeId) || (before && ((sort === "events" && beforeEvents === undefined) || (sort === "firstSeen" && !beforeFirstSeen)))) return context.json({ error: "Invalid cursor" }, 400);
      const now = dependencies.now();
      const rangeDays = { "24h": 1, "7d": 7, "14d": 14, "30d": 30, all: 14 }[query.data.range ?? "all"];
      const [issues, counts, services, environments] = await Promise.all([
        dependencies.listIssues(tenant.organizationId, {
          limit: errorIssuesPerPage,
          ...(sort ? { sort } : {}),
          ...(before && beforeId ? { before: { id: beforeId, lastSeenAt: before, ...(beforeFirstSeen ? { firstSeenAt: beforeFirstSeen } : {}), ...(beforeEvents !== undefined ? { eventCount: beforeEvents } : {}) } } : {}),
          ...(search ? { search } : {}),
          ...(service ? { service } : {}),
          ...(query.data.statuses ? { statuses: query.data.statuses } : status === "all" ? {} : { status }),
          ...(query.data.services ? { services: query.data.services } : {}),
          ...(query.data.environments ? { environments: query.data.environments } : {}),
          ...(query.data.activity ? { activity: query.data.activity, activeSince: new Date(now.getTime() - 15 * 60_000).toISOString() } : {}),
          ...(query.data.range && query.data.range !== "all" ? { since: new Date(now.getTime() - rangeDays * 86_400_000).toISOString() } : {}),
        }),
        dependencies.statusCounts(tenant.organizationId),
        dependencies.services(tenant.organizationId),
        dependencies.environments(tenant.organizationId),
      ]);
      const issueIds = issues.map((issue) => issue.id);
      // The last day's trend is hourly; longer ranges are daily.
      if (query.data.range === "24h") {
        const since = firstHour(now);
        const hours = await dependencies.hours(issueIds, since);
        return context.json({
          counts,
          environments,
          interval: "hour" as const,
          issues: issues.map((issue) => ({ ...issue, days: [], hours: hours.get(issue.id) ?? [] })),
          services,
          since,
        });
      }
      const since = firstDay(now, query.data.range && query.data.range !== "all" ? rangeDays + 1 : errorIssueListDays);
      const days = await dependencies.days(issueIds, since);
      return context.json({
        counts,
        environments,
        interval: "day" as const,
        issues: issues.map((issue) => ({ ...issue, days: days.get(issue.id) ?? [] })),
        services,
        since,
      });
    })
    .get("/services", async (context) => {
      const tenant = await access(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      return context.json({ services: await dependencies.services(tenant.organizationId) });
    })
    .get("/:issueId", async (context) => {
      const tenant = await access(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      const issueId = idSchema.safeParse(context.req.param("issueId"));
      if (!issueId.success) return context.json({ error: "Error issue not found" }, 404);
      const issue = await dependencies.findIssue(tenant.organizationId, issueId.data);
      if (!issue) return context.json({ error: "Error issue not found" }, 404);
      const since = firstDay(dependencies.now(), errorIssueDetailDays);
      const [days, hours] = await Promise.all([
        dependencies.days([issue.id], since),
        dependencies.hours([issue.id], `${since}T00:00:00.000Z`),
      ]);
      return context.json({ days: days.get(issue.id) ?? [], hours: hours.get(issue.id) ?? [], issue, since });
    })
    .patch("/:issueId", async (context) => {
      const tenant = await access(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      const issueId = idSchema.safeParse(context.req.param("issueId"));
      if (!issueId.success) return context.json({ error: "Error issue not found" }, 404);
      const body = statusSchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: "Choose open, resolved, or silenced" }, 400);
      const issue = await dependencies.setStatus(tenant.organizationId, issueId.data, body.data.status);
      if (!issue) return context.json({ error: "Error issue not found" }, 404);
      return context.json({ issue });
    });
}
