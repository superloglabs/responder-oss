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
    withStore: async (pass) => (fake ? pass(fake) : null),
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
