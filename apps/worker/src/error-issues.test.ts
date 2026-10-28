import browserErrors from "../../../packages/core/src/telemetry/fixtures/browser-errors.json" with { type: "json" };
import type { ErrorIssueStore } from "@responder/core/db/error-issues";
import type { TelemetryClient } from "@responder/core/telemetry/client";
import type { ErrorCandidate, ErrorCandidateCursor, ErrorIssueKind } from "@responder/core/telemetry/error-issues";
import { describe, expect, it, vi } from "vitest";
import { type ErrorIssueDependencies, ingestErrorIssues } from "./error-issues.js";

const organizationId = "0b9f6b9e-2f4a-4c1e-9d2b-3f8a6c1d7e01";
const now = new Date("2026-10-22T12:00:00Z");

function candidate(overrides: Partial<ErrorCandidate>): ErrorCandidate {
  return {
    attrs: {},
    body: "",
    candidate_id: "6a0d1c1e-0000-4000-8000-000000000001",
    discovered_ms: String(now.getTime() - 60_000),
    exception_message: "boom",
    exception_stacktrace: "",
    exception_type: "Error",
    kind: "span",
    project_id: organizationId,
    resource_attrs: {},
    seen_ms: String(now.getTime() - 60_000),
    service: "api",
    severity: "",
    span_id: "",
    span_name: "",
    timestamp: "2026-10-28 12:00:00.000000000",
    trace_id: "",
    ...overrides,
  };
}

function store(overrides: Partial<ErrorIssueStore> = {}) {
  const cursors = new Map<ErrorIssueKind, ErrorCandidateCursor>();
  return {
    cursor: vi.fn(async (kind: ErrorIssueKind) => cursors.get(kind) ?? null),
    cursors,
    organizationIds: vi.fn(async () => [organizationId]),
    pausedOrganizationIds: vi.fn(async () => new Set<string>()),
    record: vi.fn<ErrorIssueStore["record"]>(async () => ({ issueId: "issue-1", transition: "new" })),
    saveCursor: vi.fn(async (kind: ErrorIssueKind, cursor: ErrorCandidateCursor) => {
      cursors.set(kind, cursor);
    }),
    ...overrides,
  };
}

function dependencies(
  fake: ReturnType<typeof store> | null,
  candidates: (kind: ErrorIssueKind) => ErrorCandidate[],
): ErrorIssueDependencies {
  return {
    candidates: vi.fn(async (_client, input) => candidates(input.kind)),
    client: () => ({}) as TelemetryClient,
    now: () => now,
    sourceMaps: async () => new Map(),
    withStore: async (pass) => (fake ? pass(fake) : null),
    writeEvents: vi.fn(async () => {}),
    writer: () => null,
  };
}

describe("ingestErrorIssues", () => {
  it("does nothing without a telemetry store", async () => {
    const fake = store();
    const result = await ingestErrorIssues({ ...dependencies(fake, () => []), client: () => null });

    expect(result).toEqual([]);
    expect(fake.organizationIds).not.toHaveBeenCalled();
  });

  it("does nothing while another worker holds the lock", async () => {
    const deps = dependencies(null, () => [candidate({})]);
    expect(await ingestErrorIssues(deps)).toEqual([]);
    expect(deps.candidates).not.toHaveBeenCalled();
  });

  it("reads spans and logs for the telemetry workspaces and reports issues that opened", async () => {
    const fake = store({
      record: vi.fn<ErrorIssueStore["record"]>(async (occurrences) =>
        occurrences.kind === "span"
          ? { issueId: "span-issue", transition: "new" }
          : { issueId: "log-issue", transition: "regressed" }),
    });
    const deps = dependencies(fake, (kind) => [
      candidate({ kind, ...(kind === "log" ? { body: "failed", exception_message: "", severity: "ERROR" } : {}) }),
    ]);

    expect(await ingestErrorIssues(deps)).toEqual([
      { issueId: "span-issue", notificationsPaused: false, organizationId, transition: "new" },
      { issueId: "log-issue", notificationsPaused: false, organizationId, transition: "regressed" },
    ]);
    expect(deps.candidates).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: "span",
      organizationIds: [organizationId],
    }));
    expect(fake.saveCursor).toHaveBeenCalledTimes(2);
  });

  it("marks issues that opened in a workspace whose notifications are paused", async () => {
    const fake = store({ pausedOrganizationIds: vi.fn(async () => new Set([organizationId])) });
    const deps = dependencies(fake, (kind) => (kind === "span" ? [candidate({ kind })] : []));

    expect(await ingestErrorIssues(deps)).toEqual([
      { issueId: "issue-1", notificationsPaused: true, organizationId, transition: "new" },
    ]);
  });

  it("does not report occurrences of open or silenced issues", async () => {
    const fake = store({
      record: vi.fn<ErrorIssueStore["record"]>(async (occurrences) => ({
        issueId: "issue",
        transition: occurrences.kind === "span" ? "seen" : "silenced",
      })),
    });
    const deps = dependencies(fake, (kind) => [candidate({ kind })]);

    expect(await ingestErrorIssues(deps)).toEqual([]);
  });

  it("groups browser errors by their original source when the build uploaded maps", async () => {
    const fake = store();
    const error = browserErrors.errors.find((e) => e.browser === "chromium" && e.mechanism === "onerror")!;
    const deps = {
      ...dependencies(fake, (kind) => (kind === "log"
        ? [candidate({
          attrs: { "app.debug_ids": JSON.stringify(error.debugIds) },
          body: error.message,
          exception_message: error.message,
          exception_stacktrace: error.stacktrace,
          exception_type: error.type,
          kind,
          severity: "ERROR",
        })]
        : [])),
      sourceMaps: vi.fn(async () => new Map([[browserErrors.debugId, JSON.stringify(browserErrors.map)]])),
    };

    await ingestErrorIssues(deps);

    expect(deps.sourceMaps).toHaveBeenCalledWith(organizationId, [browserErrors.debugId]);
    const [occurrences] = vi.mocked(fake.record).mock.calls[0]!;
    expect(occurrences.frames).toEqual(["renderTotal@src/cart.js", "loadCart@src/cart.js", "onPay@src/cart.js"]);
    expect(occurrences.sample.stacktrace).toContain("at renderTotal (src/cart.js:2:15)");
    expect(occurrences.sample.attributes["exception.stacktrace.minified"]).toBe(error.stacktrace);
  });

  it("groups browser errors as they arrived when maps cannot be loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = store();
    const error = browserErrors.errors[0]!;
    const deps = {
      ...dependencies(fake, (kind) => (kind === "span"
        ? [candidate({
          attrs: { "app.debug_ids": JSON.stringify({ "https://app.test/assets/app-7D4HJW6Y.js": "5c3e1f0a-8b7d-4e6c-a1f2-9d8e7c6b5a40" }) },
          exception_stacktrace: error.stacktrace,
          kind,
        })]
        : [])),
      sourceMaps: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    };

    await ingestErrorIssues(deps);

    const [occurrences] = vi.mocked(fake.record).mock.calls[0]!;
    expect(occurrences.sample.stacktrace).toBe(error.stacktrace);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("error_issue_symbolication_failed"));
    warn.mockRestore();
  });

  it("moves past an issue whose write fails and records the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = store({
      record: vi.fn<ErrorIssueStore["record"]>(async (occurrences) => {
        if (occurrences.message === "bad") {
          throw new Error("Failed query", { cause: Object.assign(new Error("invalid byte sequence"), { code: "22021" }) });
        }
        return { issueId: "good", transition: "new" };
      }),
    });
    const deps = dependencies(fake, (kind) =>
      kind === "span"
        ? [
          candidate({ candidate_id: "6a0d1c1e-0000-4000-8000-000000000001", exception_message: "bad" }),
          candidate({ candidate_id: "6a0d1c1e-0000-4000-8000-000000000002", exception_message: "good" }),
        ]
        : []);

    expect(await ingestErrorIssues(deps)).toEqual([{ issueId: "good", notificationsPaused: false, organizationId, transition: "new" }]);
    expect(fake.cursors.get("span")).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("error_issue_record_failed"));
    warn.mockRestore();
  });
});

describe("ingestErrorIssues without the exception projection", () => {
  it("skips the pass instead of failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const missing = Object.assign(new Error("Unknown table expression identifier 'otel_issue_candidates'"), {
      code: "60",
      type: "UNKNOWN_TABLE",
    });
    const deps = dependencies(store(), () => {
      throw missing;
    });

    expect(await ingestErrorIssues(deps)).toEqual([]);
    expect(await ingestErrorIssues(deps)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("still fails on other errors", async () => {
    const deps = dependencies(store(), () => {
      throw new Error("Timeout");
    });
    await expect(ingestErrorIssues(deps)).rejects.toThrow("Timeout");
  });
});

describe("ingestErrorIssues when a write fails for another reason", () => {
  it("fails the pass without moving the cursor, so the next pass retries", async () => {
    const fake = store({
      record: vi.fn<ErrorIssueStore["record"]>(async () => {
        throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      }),
    });
    const deps = dependencies(fake, (kind) => (kind === "span" ? [candidate({})] : []));

    await expect(ingestErrorIssues(deps)).rejects.toThrow("lock timeout");
    expect(fake.saveCursor).not.toHaveBeenCalled();
  });
});

describe("ingestErrorIssues error issue events", () => {
  const writer = {} as TelemetryClient;

  it("writes each occurrence with its issue before saving the cursor", async () => {
    const order: string[] = [];
    const fake = store({
      record: vi.fn<ErrorIssueStore["record"]>(async (occurrences) => ({ issueId: `issue-${occurrences.kind}`, transition: "seen" })),
      saveCursor: vi.fn(async (kind: ErrorIssueKind) => { order.push(`cursor:${kind}`); }),
    });
    const writeEvents = vi.fn<ErrorIssueDependencies["writeEvents"]>(async (_client, rows) => { order.push(`events:${rows[0]?.kind}`); });
    const deps = {
      ...dependencies(fake, (kind) => kind === "span"
        ? [
          candidate({ candidate_id: "6a0d1c1e-0000-4000-8000-000000000001", span_id: "s1", timestamp: "2026-10-28 12:00:00.000000001", trace_id: "t1" }),
          candidate({ candidate_id: "6a0d1c1e-0000-4000-8000-000000000002", span_id: "s2", timestamp: "2026-10-28 12:00:01.000000002", trace_id: "t2" }),
        ]
        : [candidate({ body: "boom", candidate_id: "6a0d1c1e-0000-4000-8000-000000000003", kind: "log", severity: "ERROR", timestamp: "2026-10-28 12:00:02.000000003" })]),
      writeEvents,
      writer: () => writer,
    };

    await ingestErrorIssues(deps);

    expect(order).toEqual(["events:span", "cursor:span", "events:log", "cursor:log"]);
    const spanRows = writeEvents.mock.calls[0]![1];
    expect(spanRows).toEqual([
      { candidateId: "6a0d1c1e-0000-4000-8000-000000000001", fingerprint: expect.stringMatching(/^v2:/), issueId: "issue-span", kind: "span", organizationId, service: "api", spanId: "s1", timestamp: "2026-10-28 12:00:00.000000001", traceId: "t1" },
      { candidateId: "6a0d1c1e-0000-4000-8000-000000000002", fingerprint: spanRows[0]!.fingerprint, issueId: "issue-span", kind: "span", organizationId, service: "api", spanId: "s2", timestamp: "2026-10-28 12:00:01.000000002", traceId: "t2" },
    ]);
    expect(writeEvents.mock.calls[1]![1]).toMatchObject([{ issueId: "issue-log", kind: "log", timestamp: "2026-10-28 12:00:02.000000003" }]);
  });

  it("leaves out the occurrences of an issue whose write was skipped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = store({
      record: vi.fn<ErrorIssueStore["record"]>(async (occurrences) => {
        if (occurrences.message === "bad") throw Object.assign(new Error("invalid byte sequence"), { code: "22021" });
        return { issueId: "good", transition: "seen" };
      }),
    });
    const writeEvents = vi.fn<ErrorIssueDependencies["writeEvents"]>(async () => {});
    await ingestErrorIssues({
      ...dependencies(fake, (kind) => kind === "span"
        ? [candidate({ exception_message: "bad", trace_id: "bad" }), candidate({ exception_message: "good", trace_id: "good" })]
        : []),
      writeEvents,
      writer: () => writer,
    });

    expect(writeEvents.mock.calls[0]![1].map((row) => row.traceId)).toEqual(["good"]);
    warn.mockRestore();
  });

  it("fails the pass without moving the cursor when the events cannot be written", async () => {
    const fake = store();
    const missing = Object.assign(new Error("Unknown table expression identifier 'error_issue_events'"), { type: "UNKNOWN_TABLE" });
    const deps = {
      ...dependencies(fake, (kind) => (kind === "span" ? [candidate({})] : [])),
      writeEvents: vi.fn(async () => { throw missing; }),
      writer: () => writer,
    };

    await expect(ingestErrorIssues(deps)).rejects.toThrow("Could not write error issue events");
    expect(fake.saveCursor).not.toHaveBeenCalled();
  });

  it("does not write events in a cell without a writer", async () => {
    const deps = dependencies(store(), (kind) => (kind === "span" ? [candidate({})] : []));
    await ingestErrorIssues(deps);
    expect(deps.writeEvents).not.toHaveBeenCalled();
  });
});
