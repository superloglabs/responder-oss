import { describe, expect, it, vi } from "vitest";
import type { ErrorIssue, ErrorIssueSummary } from "../../../../packages/core/src/db/error-issues.js";
import { createErrorIssueRoutes, type ErrorIssueRouteDependencies, firstDay } from "./error-issue-routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const issueId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-22T12:00:00.000Z");

const summary: ErrorIssueSummary = {
  eventCount: 12,
  exceptionType: "TypeError",
  firstSeenAt: "2026-10-20T08:00:00.000Z",
  id: issueId,
  kind: "span",
  lastSeenAt: "2026-10-22T11:59:00.000Z",
  regressedAt: null,
  service: "api",
  status: "open",
  statusChangedAt: null,
  title: "TypeError: Cannot read properties of undefined",
  topFrame: "loadInvoice@apps/api/src/invoices.ts",
};

const issue: ErrorIssue = {
  ...summary,
  fingerprint: "v1:2e22350e88415f95",
  frames: ["loadInvoice@apps/api/src/invoices.ts"],
  lastSample: {
    attributes: {},
    kind: "span",
    message: "Cannot read properties of undefined",
    resourceAttributes: {},
    seenAt: summary.lastSeenAt,
    service: "api",
    severity: null,
    spanId: null,
    spanName: null,
    stacktrace: null,
    traceId: null,
  },
  message: "Cannot read properties of undefined",
};

function routes(overrides: Partial<ErrorIssueRouteDependencies> = {}) {
  const dependencies: ErrorIssueRouteDependencies = {
    environments: vi.fn(async () => ["production"]),
    days: vi.fn(async () => new Map([[issueId, [{ day: "2026-10-22", eventCount: 12 }]]])),
    findIssue: vi.fn(async () => issue),
    hasCapability: vi.fn(async () => true),
    listIssues: vi.fn(async () => [summary]),
    now: () => now,
    services: vi.fn(async () => ["api"]),
    setStatus: vi.fn(async (_organizationId, _issueId, status) => ({ ...issue, status })),
    statusCounts: vi.fn(async () => ({ open: 1, resolved: 2, silenced: 0 })),
    tenant: vi.fn(async () => ({ ok: true as const, organizationId, user: { id: "user" } })),
    ...overrides,
  };
  return { app: createErrorIssueRoutes(dependencies), dependencies };
}

describe("error issue routes", () => {
  it("lists open issues with their counts per day, status counts and services", async () => {
    const { app, dependencies } = routes();
    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      counts: { open: 1, resolved: 2, silenced: 0 },
      environments: ["production"],
      issues: [{ ...summary, days: [{ day: "2026-10-22", eventCount: 12 }] }],
      services: ["api"],
      since: "2026-10-09",
    });
    expect(dependencies.listIssues).toHaveBeenCalledWith(organizationId, { limit: 50, status: "open" });
    expect(dependencies.days).toHaveBeenCalledWith([issueId], "2026-10-09");
  });

  it("filters by status, service and text, and pages from the last issue", async () => {
    const { app, dependencies } = routes();
    const query = new URLSearchParams({
      before: summary.lastSeenAt,
      beforeId: issueId,
      search: "invoice",
      service: "api",
      status: "all",
    });
    await app.request(`/?${query}`);

    expect(dependencies.listIssues).toHaveBeenCalledWith(organizationId, {
      before: { id: issueId, lastSeenAt: summary.lastSeenAt },
      limit: 50,
      search: "invoice",
      service: "api",
    });
  });

  it("combines multiple values with independent activity, environment and time filters", async () => {
    const { app, dependencies } = routes();
    const response = await app.request("/?statuses=open&statuses=resolved&services=api&services=worker&environments=production&activity=inactive&range=24h&search=11111111");
    expect(response.status).toBe(200);
    expect(dependencies.listIssues).toHaveBeenCalledWith(organizationId, {
      limit: 50, statuses: ["open", "resolved"], services: ["api", "worker"], environments: ["production"],
      activity: "inactive", activeSince: "2026-10-22T11:45:00.000Z", since: "2026-10-21T12:00:00.000Z", search: "11111111",
    });
  });

  it("rejects malformed filters and incomplete sort cursors", async () => {
    const { app, dependencies } = routes();
    for (const query of ["statuses=unknown", "activity=unknown", "range=forever", "sort=unknown", `before=${summary.lastSeenAt}`, `before=${summary.lastSeenAt}&beforeId=${issueId}&sort=events`]) {
      expect((await app.request(`/?${query}`)).status).toBe(400);
    }
    expect(dependencies.listIssues).not.toHaveBeenCalled();
  });

  it("pages event sorting with its count and ID to break ties", async () => {
    const { app, dependencies } = routes();
    expect((await app.request(`/?sort=events&before=${summary.lastSeenAt}&beforeId=${issueId}&beforeEvents=12`)).status).toBe(200);
    expect(dependencies.listIssues).toHaveBeenCalledWith(organizationId, { limit: 50, status: "open", sort: "events", before: { id: issueId, lastSeenAt: summary.lastSeenAt, eventCount: 12 } });
  });

  it("lists the services issues came from", async () => {
    const { app } = routes();
    expect(await (await app.request("/services")).json()).toEqual({ services: ["api"] });
  });

  it("rejects an unknown status filter", async () => {
    const { app } = routes();
    expect((await app.request("/?status=ignored")).status).toBe(400);
  });

  it("is not available without telemetry", async () => {
    const { app, dependencies } = routes({ hasCapability: vi.fn(async () => false) });
    expect((await app.request("/")).status).toBe(404);
    expect((await app.request(`/${issueId}`)).status).toBe(404);
    expect(dependencies.listIssues).not.toHaveBeenCalled();
  });

  it("returns an issue with 30 days of counts", async () => {
    const { app, dependencies } = routes();
    const response = await app.request(`/${issueId}`);

    expect(await response.json()).toEqual({ days: [{ day: "2026-10-22", eventCount: 12 }], issue, since: "2026-09-23" });
    expect(dependencies.findIssue).toHaveBeenCalledWith(organizationId, issueId);
  });

  it("answers 404 for a malformed or missing issue", async () => {
    const { app } = routes({ findIssue: vi.fn(async () => null) });
    expect((await app.request("/not-an-id")).status).toBe(404);
    expect((await app.request(`/${issueId}`)).status).toBe(404);
  });

  it("changes an issue's status", async () => {
    const { app, dependencies } = routes();
    const response = await app.request(`/${issueId}`, {
      body: JSON.stringify({ status: "resolved" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { issue: ErrorIssue }).issue.status).toBe("resolved");
    expect(dependencies.setStatus).toHaveBeenCalledWith(organizationId, issueId, "resolved");
  });

  it("rejects an unknown status", async () => {
    const { app, dependencies } = routes();
    const response = await app.request(`/${issueId}`, {
      body: JSON.stringify({ status: "deleted" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });

    expect(response.status).toBe(400);
    expect(dependencies.setStatus).not.toHaveBeenCalled();
  });
});

describe("firstDay", () => {
  it("counts today as the last day of the range", () => {
    expect(firstDay(now, 1)).toBe("2026-10-22");
    expect(firstDay(now, 14)).toBe("2026-10-09");
  });
});
