import { Hono } from "hono";
import { z } from "zod";
import {
  errorIssueDays,
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
  findIssue: typeof findErrorIssue;
  hasCapability: (organizationId: string, capability: "telemetry") => Promise<boolean>;
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
  findIssue: findErrorIssue,
  hasCapability: organizationHasCapability,
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
  before: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
  search: z.string().trim().max(200).optional(),
  service: z.string().trim().min(1).max(200).optional(),
  status: z.enum([...errorIssueStatuses, "all"]).default("open"),
});
const statusSchema = z.object({ status: z.enum(errorIssueStatuses) });

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
      const query = listQuerySchema.safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid filter" }, 400);
      const { before, beforeId, search, service, status } = query.data;
      const [issues, counts, services] = await Promise.all([
        dependencies.listIssues(tenant.organizationId, {
          limit: errorIssuesPerPage,
          ...(before && beforeId ? { before: { id: beforeId, lastSeenAt: before } } : {}),
          ...(search ? { search } : {}),
          ...(service ? { service } : {}),
          ...(status === "all" ? {} : { status }),
        }),
        dependencies.statusCounts(tenant.organizationId),
        dependencies.services(tenant.organizationId),
      ]);
      const since = firstDay(dependencies.now(), errorIssueListDays);
      const days = await dependencies.days(issues.map((issue) => issue.id), since);
      return context.json({
        counts,
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
      const days = await dependencies.days([issue.id], since);
      return context.json({ days: days.get(issue.id) ?? [], issue, since });
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
