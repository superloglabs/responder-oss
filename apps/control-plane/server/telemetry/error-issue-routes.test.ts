import { describe, expect, it, vi } from "vitest";
import type { ErrorIssue, ErrorIssueSummary } from "../../../../packages/core/src/db/error-issues.js";
import { fingerprintLog } from "../../../../packages/core/src/telemetry/fingerprint.js";
import { fingerprintLogV1 } from "../../../../packages/core/src/telemetry/fingerprint-v1.js";
import { createErrorIssueRoutes, type ErrorIssueRouteDependencies, firstDay, firstHour } from "./error-issue-routes.js";

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
    findIssueIdByFingerprint: vi.fn(async () => issueId),
    hasCapability: vi.fn(async () => true),
    hours: vi.fn(async () => new Map([[issueId, [{ eventCount: 12, hour: "2026-10-22T11:00:00.000Z" }]]])),
    listIssues: vi.fn(async () => [summary]),
    now: () => now,
    services: vi.fn(async () => ["api"]),
    setStatus: vi.fn(async (_organizationId, _issueId, status) => ({ ...issue, status })),
    sourceMaps: vi.fn(async () => new Map()),
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
      interval: "day",
      issues: [{ ...summary, days: [{ day: "2026-10-22", eventCount: 12 }] }],
      services: ["api"],
      since: "2026-10-09",
    });
    expect(dependencies.listIssues).toHaveBeenCalledWith(organizationId, { limit: 50, status: "open" });
    expect(dependencies.days).toHaveBeenCalledWith([issueId], "2026-10-09");
    expect(dependencies.hours).not.toHaveBeenCalled();
  });

  it("lists the last 24 hours with counts per hour", async () => {
    const { app, dependencies } = routes();
    const body = await (await app.request("/?range=24h")).json() as { interval: string; issues: unknown[]; since: string };

    expect(body.interval).toBe("hour");
    expect(body.since).toBe("2026-10-21T13:00:00.000Z");
    expect(body.issues).toEqual([{ ...summary, days: [], hours: [{ eventCount: 12, hour: "2026-10-22T11:00:00.000Z" }] }]);
    expect(dependencies.hours).toHaveBeenCalledWith([issueId], "2026-10-21T13:00:00.000Z");
    expect(dependencies.days).not.toHaveBeenCalled();
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

    expect(await response.json()).toEqual({ days: [{ day: "2026-10-22", eventCount: 12 }], hours: [{ eventCount: 12, hour: "2026-10-22T11:00:00.000Z" }], issue, since: "2026-09-23" });
    expect(dependencies.hours).toHaveBeenCalledWith([issueId], "2026-09-23T00:00:00.000Z");
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

describe("error issue for a log", () => {
  const log = {
    attributes: {},
    body: "payment failed for order 4821",
    exceptionMessage: "",
    exceptionStacktrace: "",
    exceptionType: "",
    service: "api",
    severity: "ERROR",
    severityNumber: 17,
  };

  function lookup(app: ReturnType<typeof routes>["app"], body: unknown) {
    return app.request("/for-log", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  it("finds the issue by the log's fingerprint, as the worker computes it", async () => {
    const { app, dependencies } = routes();
    const response = await lookup(app, log);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ issueId });
    const input = { body: log.body, exceptionType: null, message: null, service: "api", severity: "ERROR", stacktrace: null };
    expect(dependencies.findIssueIdByFingerprint).toHaveBeenCalledWith(
      organizationId,
      fingerprintLog(input).hash,
      [fingerprintLogV1(input)],
    );
  });

  it("answers null when no issue has the fingerprint", async () => {
    const { app } = routes({ findIssueIdByFingerprint: vi.fn(async () => null) });
    expect(await (await lookup(app, log)).json()).toEqual({ issueId: null });
  });

  it("groups the stack as it arrived when source maps fail to load", async () => {
    const stacktrace = "TypeError: x is undefined\n    at render (https://app.example.com/assets/index-abc.js:1:200)";
    const { app, dependencies } = routes({ sourceMaps: vi.fn(async () => { throw new Error("database down"); }) });
    const response = await lookup(app, {
      ...log,
      attributes: { "app.debug_ids": JSON.stringify({ "https://app.example.com/assets/index-abc.js": "11111111-2222-4333-8444-555555555555" }) },
      exceptionStacktrace: stacktrace,
      exceptionType: "TypeError",
    });

    expect(await response.json()).toEqual({ issueId });
    expect(dependencies.sourceMaps).toHaveBeenCalled();
    expect(dependencies.findIssueIdByFingerprint).toHaveBeenCalledWith(
      organizationId,
      fingerprintLog({ body: log.body, exceptionType: "TypeError", message: null, service: "api", severity: "ERROR", stacktrace }).hash,
      expect.any(Array),
    );
  });

  it("rejects logs below ERROR", async () => {
    const { app, dependencies } = routes();
    expect((await lookup(app, { ...log, severity: "WARN", severityNumber: 13 })).status).toBe(400);
    expect(dependencies.findIssueIdByFingerprint).not.toHaveBeenCalled();
  });

  it("is not available without telemetry", async () => {
    const { app, dependencies } = routes({ hasCapability: vi.fn(async () => false) });
    expect((await lookup(app, log)).status).toBe(404);
    expect(dependencies.findIssueIdByFingerprint).not.toHaveBeenCalled();
  });
});

describe("firstHour", () => {
  it("counts the current hour as the last of 24", () => {
    expect(firstHour(new Date("2026-10-22T12:34:56.789Z"))).toBe("2026-10-21T13:00:00.000Z");
  });
});

describe("firstDay", () => {
  it("counts today as the last day of the range", () => {
    expect(firstDay(now, 1)).toBe("2026-10-22");
    expect(firstDay(now, 14)).toBe("2026-10-09");
  });
});
