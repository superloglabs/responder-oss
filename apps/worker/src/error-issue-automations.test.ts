import type { ErrorIssue } from "@responder/core/db/error-issues";
import { describe, expect, it, vi } from "vitest";
import {
  type ErrorIssueAutomationDependencies,
  errorIssueTriggerBody,
  errorRunsPerAutomationPerPass,
  startErrorIssueAutomations,
} from "./error-issue-automations.js";

const organizationId = "0b9f6b9e-2f4a-4c1e-9d2b-3f8a6c1d7e01";
const issueId = "11111111-1111-4111-8111-111111111111";

const issue: ErrorIssue = {
  eventCount: 1834,
  exceptionType: "TypeError",
  fingerprint: "v1:2e22350e88415f95",
  firstSeenAt: "2026-10-13T08:00:00.000Z",
  frames: ["loadInvoice@apps/api/src/invoices.ts"],
  id: issueId,
  kind: "span",
  lastSample: {
    attributes: { "http.route": "/invoices/:id" },
    kind: "span",
    message: "Cannot read properties of undefined (reading 'id')",
    resourceAttributes: { "service.name": "api" },
    seenAt: "2026-10-22T11:59:00.000Z",
    service: "api",
    severity: null,
    spanId: "b7ad6b7169203331",
    spanName: "GET /invoices/:id",
    stacktrace: "TypeError: Cannot read properties of undefined (reading 'id')\n    at loadInvoice (apps/api/src/invoices.ts:40:12)",
    traceId: "0af7651916cd43dd8448eb211c80319c",
  },
  lastSeenAt: "2026-10-22T11:59:00.000Z",
  message: "Cannot read properties of undefined (reading 'id')",
  regressedAt: "2026-10-22T11:59:30.000Z",
  service: "api",
  status: "open",
  statusChangedAt: "2026-10-22T11:59:30.000Z",
  title: "TypeError: Cannot read properties of undefined (reading 'id')",
  topFrame: "loadInvoice@apps/api/src/invoices.ts",
};

function dependencies(overrides: Partial<ErrorIssueAutomationDependencies> = {}): ErrorIssueAutomationDependencies {
  let runs = 0;
  return {
    abandon: vi.fn(async () => true),
    begin: vi.fn(async () => ({ created: true as const, organizationId, runId: `run-${++runs}` })) as unknown as ErrorIssueAutomationDependencies["begin"],
    find: vi.fn(async () => [{ automationId: "automation-1" }]),
    issue: vi.fn(async (_organizationId: string, id: string) => ({ ...issue, id })),
    origin: "https://superlog.sh",
    paused: vi.fn(async () => new Set<string>()),
    queue: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("startErrorIssueAutomations", () => {
  it("starts a run per matching automation with the issue as its trigger", async () => {
    const deps = dependencies({ find: vi.fn(async () => [{ automationId: "automation-1" }, { automationId: "automation-2" }]) });

    expect(await startErrorIssueAutomations([{ issueId, organizationId, transition: "new" }], deps)).toBe(2);
    expect(deps.find).toHaveBeenCalledWith({ eventType: "new_issue", organizationId, service: "api" });
    expect(deps.begin).toHaveBeenCalledWith({
      automationId: "automation-1",
      trigger: expect.objectContaining({
        attributes: expect.objectContaining({ fingerprint: issue.fingerprint, issueId, service: "api", transition: "new" }),
        externalEventId: `error-issue:${issueId}:new`,
        provider: "errors",
        sourceUrl: `https://superlog.sh/errors/${issueId}`,
        title: issue.title,
      }),
    });
    expect(deps.queue).toHaveBeenCalledTimes(2);
  });

  it("starts nothing for workspaces whose notifications are paused", async () => {
    const pausedOrganizationId = "0b9f6b9e-2f4a-4c1e-9d2b-3f8a6c1d7e02";
    const deps = dependencies({ paused: vi.fn(async () => new Set([pausedOrganizationId])) });

    expect(await startErrorIssueAutomations([
      { issueId: "22222222-2222-4222-8222-222222222222", organizationId: pausedOrganizationId, transition: "new" },
      { issueId, organizationId, transition: "new" },
    ], deps)).toBe(1);
    expect(deps.paused).toHaveBeenCalledWith([pausedOrganizationId, organizationId]);
    expect(deps.issue).toHaveBeenCalledTimes(1);
    expect(deps.issue).toHaveBeenCalledWith(organizationId, issueId);
  });

  it("runs once per regression, keyed by when the issue reopened", async () => {
    const deps = dependencies();
    await startErrorIssueAutomations([{ issueId, organizationId, transition: "regressed" }], deps);

    expect(deps.find).toHaveBeenCalledWith(expect.objectContaining({ eventType: "regression" }));
    expect(deps.begin).toHaveBeenCalledWith(expect.objectContaining({
      trigger: expect.objectContaining({ externalEventId: `error-issue:${issueId}:regressed:2026-10-22T11:59:30.000Z` }),
    }));
  });

  it("does not queue a run that already exists", async () => {
    const deps = dependencies({
      begin: vi.fn(async () => ({ created: false as const, organizationId, runId: "run" })) as unknown as ErrorIssueAutomationDependencies["begin"],
    });
    expect(await startErrorIssueAutomations([{ issueId, organizationId, transition: "new" }], deps)).toBe(0);
    expect(deps.queue).not.toHaveBeenCalled();
  });

  it("abandons a run whose job cannot be queued and goes on with the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const queue = vi.fn().mockRejectedValueOnce(new Error("queue down")).mockResolvedValue(undefined);
    const deps = dependencies({ queue });
    const changes = [
      { issueId, organizationId, transition: "new" as const },
      { issueId: "22222222-2222-4222-8222-222222222222", organizationId, transition: "new" as const },
    ];

    expect(await startErrorIssueAutomations(changes, deps)).toBe(1);
    expect(deps.abandon).toHaveBeenCalledWith("run-1");
    warn.mockRestore();
  });

  it("counts only queued runs toward the per-pass limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const queue = vi.fn();
    for (let index = 0; index < errorRunsPerAutomationPerPass; index += 1) queue.mockRejectedValueOnce(new Error("queue down"));
    queue.mockResolvedValue(undefined);
    const deps = dependencies({ queue });
    const changes = Array.from({ length: errorRunsPerAutomationPerPass + 2 }, (_, index) => ({
      issueId: `issue-${index}`,
      organizationId,
      transition: "new" as const,
    }));

    expect(await startErrorIssueAutomations(changes, deps)).toBe(2);
    warn.mockRestore();
  });

  it(`starts at most ${errorRunsPerAutomationPerPass} runs per automation in a pass`, async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = dependencies();
    const changes = Array.from({ length: errorRunsPerAutomationPerPass + 3 }, (_, index) => ({
      issueId: `issue-${index}`,
      organizationId,
      transition: "new" as const,
    }));

    expect(await startErrorIssueAutomations(changes, deps)).toBe(errorRunsPerAutomationPerPass);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("too_many_runs"));
    warn.mockRestore();
  });

  it("skips issues without a matching automation or that no longer exist", async () => {
    const deps = dependencies({ find: vi.fn(async () => []) });
    expect(await startErrorIssueAutomations([{ issueId, organizationId, transition: "new" }], deps)).toBe(0);
    expect(deps.begin).not.toHaveBeenCalled();

    const gone = dependencies({ issue: vi.fn(async () => null) });
    expect(await startErrorIssueAutomations([{ issueId, organizationId, transition: "new" }], gone)).toBe(0);
    expect(gone.find).not.toHaveBeenCalled();
  });
});

describe("errorIssueTriggerBody", () => {
  it("describes the issue and its newest occurrence", () => {
    const body = errorIssueTriggerBody(issue, "regressed", "https://superlog.sh/errors/1");

    expect(body).toContain("# Error regression: TypeError: Cannot read properties of undefined (reading 'id')");
    expect(body).toContain("This error issue was resolved and has occurred again.");
    expect(body).toContain("- Events: 1,834");
    expect(body).toContain("- Issue: https://superlog.sh/errors/1");
    expect(body).toContain("- loadInvoice@apps/api/src/invoices.ts");
    expect(body).toContain("    at loadInvoice (apps/api/src/invoices.ts:40:12)");
    expect(body).toContain("Trace ID: 0af7651916cd43dd8448eb211c80319c, span ID: b7ad6b7169203331 (GET /invoices/:id)");
    expect(body).toContain("- http.route: /invoices/:id");
  });

  it("shortens long stack traces", () => {
    const long = errorIssueTriggerBody(
      { ...issue, lastSample: { ...issue.lastSample, stacktrace: "x".repeat(20_000) } },
      "new",
      null,
    );
    expect(long.length).toBeLessThan(10_000);
    expect(long).not.toContain("- Issue:");
  });
});
