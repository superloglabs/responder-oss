import { describe, expect, it } from "vitest";
import type { TelemetryClient } from "./client.js";
import {
  type ErrorCandidate,
  errorCandidates,
  errorCandidateSettleMs,
  errorCandidateWindow,
  errorCandidateWindowMs,
  errorIssueTitle,
  groupErrorCandidates,
  nextErrorCandidateCursor,
  occurrenceTransition,
  zeroCandidateId,
} from "./error-issues.js";

const organizationId = "0b9f6b9e-2f4a-4c1e-9d2b-3f8a6c1d7e01";
const stack = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "    at loadInvoice (/var/task/apps/api/src/invoices.ts:40:12)",
  "    at handler (/var/task/apps/api/src/routes.ts:12:3)",
].join("\n");

function candidate(overrides: Partial<ErrorCandidate> = {}): ErrorCandidate {
  return {
    attrs: { "http.route": "/invoices/:id" },
    body: "",
    candidate_id: "6a0d1c1e-0000-4000-8000-000000000001",
    discovered_ms: "1793000000000",
    exception_message: "Cannot read properties of undefined (reading 'id')",
    exception_stacktrace: stack,
    exception_type: "TypeError",
    kind: "span",
    project_id: organizationId,
    resource_attrs: { "service.name": "api", "superlog.project_id": organizationId },
    seen_ms: "1793000000000",
    service: "api",
    severity: "",
    span_id: "b7ad6b7169203331",
    span_name: "GET /invoices/:id",
    trace_id: "0af7651916cd43dd8448eb211c80319c",
    ...overrides,
  };
}

describe("groupErrorCandidates", () => {
  it("collapses occurrences of one fingerprint and keeps the newest as the sample", () => {
    const [issue, ...rest] = groupErrorCandidates([
      candidate({ seen_ms: "1793000000000", trace_id: "first" }),
      candidate({ seen_ms: "1793000060000", trace_id: "newest" }),
      candidate({ seen_ms: "1792999940000", trace_id: "oldest" }),
    ]);

    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      eventCount: 3,
      firstSeenAt: new Date(1792999940000),
      kind: "span",
      lastSeenAt: new Date(1793000060000),
      organizationId,
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      topFrame: "loadInvoice@apps/api/src/invoices.ts",
    });
    expect(issue?.sample.traceId).toBe("newest");
    expect(issue?.fingerprint).toMatch(/^v1:/);
  });

  it("keeps workspaces apart even for the same fingerprint", () => {
    const groups = groupErrorCandidates([
      candidate(),
      candidate({ project_id: "5c3e1f0a-8b7d-4e6c-a1f2-9d8e7c6b5a40" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.fingerprint).toBe(groups[1]?.fingerprint);
  });

  it("counts occurrences per UTC day", () => {
    const [issue] = groupErrorCandidates([
      candidate({ seen_ms: String(Date.parse("2026-10-21T23:59:00Z")) }),
      candidate({ seen_ms: String(Date.parse("2026-10-22T00:01:00Z")) }),
      candidate({ seen_ms: String(Date.parse("2026-10-22T08:00:00Z")) }),
    ]);

    expect(issue?.dailyCounts).toEqual({ "2026-10-21": 1, "2026-10-22": 2 });
  });

  it("counts occurrences per UTC hour", () => {
    const [issue] = groupErrorCandidates([
      candidate({ seen_ms: String(Date.parse("2026-10-22T07:59:59Z")) }),
      candidate({ seen_ms: String(Date.parse("2026-10-22T08:00:00Z")) }),
      candidate({ seen_ms: String(Date.parse("2026-10-22T08:59:00Z")) }),
    ]);

    expect(issue?.hourlyCounts).toEqual({ "2026-10-22T07:00:00.000Z": 1, "2026-10-22T08:00:00.000Z": 2 });
  });

  it("groups logs without a stack by their normalized body", () => {
    const log = (body: string) =>
      candidate({
        body,
        exception_message: "",
        exception_stacktrace: "",
        exception_type: "",
        kind: "log",
        severity: "ERROR",
      });
    const groups = groupErrorCandidates([
      log("payment 4411 failed for customer 9"),
      log("payment 4412 failed for customer 17"),
      log("refund failed"),
    ]);

    expect(groups.map((group) => group.eventCount)).toEqual([2, 1]);
    expect(groups[0]).toMatchObject({ exceptionType: "ERROR", title: "ERROR: payment 4412 failed for customer 17" });
  });

  it("drops the workspace attribute and NUL bytes from the sample", () => {
    const [issue] = groupErrorCandidates([candidate({ exception_message: `bad${String.fromCharCode(0)} input` })]);

    expect(issue?.sample.resourceAttributes).toEqual({ "service.name": "api" });
    expect(issue?.message).toBe("bad input");
  });
});

describe("errorIssueTitle", () => {
  it("uses the first line of the message, then the top frame", () => {
    expect(errorIssueTitle({ exceptionType: "Error", topFrame: "run@src/job.ts" }, "\nfirst line\nsecond")).toBe(
      "Error: first line",
    );
    expect(errorIssueTitle({ exceptionType: "Error", topFrame: "run@src/job.ts" }, null)).toBe("Error in run@src/job.ts");
    expect(errorIssueTitle({ exceptionType: "Error", topFrame: null }, "")).toBe("Error");
  });

  it("shortens long titles", () => {
    expect(errorIssueTitle({ exceptionType: "Error", topFrame: null }, "x".repeat(500))).toHaveLength(200);
  });
});

describe("occurrenceTransition", () => {
  const resolvedAt = new Date("2026-10-22T12:00:00Z");
  const after = new Date("2026-10-22T12:00:01Z");

  it("opens new issues, reopens resolved ones, and leaves silenced ones silent", () => {
    expect(occurrenceTransition(null, after)).toBe("new");
    expect(occurrenceTransition({ status: "resolved", statusChangedAt: resolvedAt }, after)).toBe("regressed");
    expect(occurrenceTransition({ status: "silenced", statusChangedAt: resolvedAt }, after)).toBe("silenced");
    expect(occurrenceTransition({ status: "open", statusChangedAt: null }, after)).toBe("seen");
  });

  it("does not reopen a resolved issue for occurrences from before it was resolved", () => {
    expect(occurrenceTransition({ status: "resolved", statusChangedAt: resolvedAt }, resolvedAt)).toBe("seen");
    expect(occurrenceTransition({ status: "resolved", statusChangedAt: null }, resolvedAt)).toBe("regressed");
  });
});

describe("error candidate cursor", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const settled = new Date(now.getTime() - errorCandidateSettleMs);

  it("starts a first pass at the settle time", () => {
    expect(errorCandidateWindow(null, now)).toEqual({
      cursor: { candidateId: zeroCandidateId, discoveredAt: settled },
      until: settled,
    });
  });

  it("reads a bounded window that stops at the settle time", () => {
    const behind = { candidateId: zeroCandidateId, discoveredAt: new Date(now.getTime() - 60 * 60_000) };
    expect(errorCandidateWindow(behind, now).until).toEqual(
      new Date(behind.discoveredAt.getTime() + errorCandidateWindowMs),
    );

    const recent = { candidateId: zeroCandidateId, discoveredAt: new Date(now.getTime() - 60_000) };
    expect(errorCandidateWindow(recent, now).until).toEqual(settled);
  });

  it("never moves the window end behind the cursor", () => {
    const ahead = { candidateId: zeroCandidateId, discoveredAt: new Date(now.getTime() - 1_000) };
    expect(errorCandidateWindow(ahead, now).until).toEqual(ahead.discoveredAt);
  });

  it("stops a full batch at its last row", () => {
    const window = errorCandidateWindow({ candidateId: zeroCandidateId, discoveredAt: new Date(0) }, now);
    const rows = [
      { candidate_id: "a", discovered_ms: "1000" },
      { candidate_id: "b", discovered_ms: "2000" },
    ];
    expect(nextErrorCandidateCursor(window, rows, 2)).toEqual({ candidateId: "b", discoveredAt: new Date(2000) });
  });

  it("moves a partial batch to the window end", () => {
    const window = errorCandidateWindow({ candidateId: zeroCandidateId, discoveredAt: new Date(0) }, now);
    expect(nextErrorCandidateCursor(window, [{ candidate_id: "a", discovered_ms: "1000" }], 2)).toEqual({
      candidateId: zeroCandidateId,
      discoveredAt: window.until,
    });
  });

  it("keeps the candidate ID when the window has not moved", () => {
    const cursor = { candidateId: "b", discoveredAt: settled };
    const window = errorCandidateWindow(cursor, now);
    expect(nextErrorCandidateCursor(window, [], 2)).toBe(cursor);
  });
});

describe("errorCandidates", () => {
  it("bounds the read by the cursor time so ClickHouse prunes older rows", async () => {
    const calls: { query: string; query_params?: Record<string, unknown> }[] = [];
    const client = {
      query: async (call: { query: string; query_params?: Record<string, unknown> }) => {
        calls.push(call);
        return { json: async () => [] };
      },
    } as unknown as TelemetryClient;
    const cursor = { candidateId: "6a0d1c1e-0000-4000-8000-000000000001", discoveredAt: new Date(1_000) };

    await errorCandidates(client, {
      kind: "log",
      limit: 100,
      organizationIds: [organizationId],
      window: { cursor, until: new Date(2_000) },
    });

    expect(calls[0]?.query).toContain("discovered_at >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')");
    expect(calls[0]?.query_params).toMatchObject({ fromId: cursor.candidateId, fromMs: 1_000, untilMs: 2_000 });
  });
});

describe("groupErrorCandidates with a Python traceback as the log body", () => {
  it("titles the issue with the exception and keeps the traceback as the stack", () => {
    const body = [
      "Traceback (most recent call last):",
      '  File "/srv/app/billing/totals.py", line 7, in compute_total',
      "TypeError: unsupported operand type(s)",
    ].join("\n");
    const [issue] = groupErrorCandidates([
      candidate({ body, exception_message: "", exception_stacktrace: "", exception_type: "", kind: "log", severity: "ERROR" }),
    ]);

    expect(issue).toMatchObject({
      exceptionType: "TypeError",
      title: "TypeError: unsupported operand type(s)",
      topFrame: "compute_total@app/billing/totals.py",
    });
    expect(issue?.sample.stacktrace).toBe(body);
  });
});
