import { describe, expect, it } from "vitest";
import {
  activityLabel,
  automationRunActivity,
  automationRunTimeline,
  formatDuration,
  lastAgentMessage,
  toolGroupSummary,
} from "./automation-run-timeline";
import type { AutomationRunDetail, AutomationRunEvent } from "./automations-api";

function run(events: Array<Omit<AutomationRunEvent, "createdAt" | "id">>, overrides: Partial<AutomationRunDetail> = {}): AutomationRunDetail {
  return {
    automationEnabled: true,
    automationId: "automation-1",
    automationName: "Investigate production errors",
    cancelRequestedAt: null,
    completedAt: "2026-09-24T10:20:00.000Z",
    createdAt: "2026-09-24T10:16:00.000Z",
    events: events.map((event, index) => ({ ...event, createdAt: "2026-09-24T10:16:00.000Z", id: index + 1 })),
    failureCategory: null,
    failureMessage: null,
    id: "run-1",
    number: 127,
    resultSummary: null,
    startedAt: "2026-09-24T10:16:00.000Z",
    status: "succeeded",
    trigger: { attributes: {}, provider: "sentry", sourceUrl: null, title: "Payment webhook timeout" },
    ...overrides,
  };
}

describe("automationRunTimeline", () => {
  it("opens with the trigger and groups consecutive tools between messages", () => {
    const entries = automationRunTimeline(run([
      { data: {}, type: "run_started" },
      { data: { items: [
        { kind: "message", text: "I'll trace the timeout." },
        { action: "read", kind: "tool", status: "succeeded", target: "src/webhooks/payments.ts" },
        { action: "query", kind: "tool", provider: "sentry", status: "succeeded", target: "get_issue" },
        { kind: "message", text: "Fixed it." },
      ], truncated: false }, type: "transcript" },
      { data: { externalReference: "https://github.com/acme/app/pull/248", kind: "open_github_pull_request", repository: "acme/app", title: "Fix payment webhook timeouts" }, type: "action_succeeded" },
      { data: null, type: "run_succeeded" },
    ]));

    expect(entries.map((entry) => entry.kind)).toEqual(["trigger", "message", "activity", "message", "pullRequest"]);
    expect(entries[2]).toMatchObject({ steps: [{ action: "read" }, { action: "query" }] });
    expect(entries[4]).toMatchObject({ number: "248", repository: "acme/app", title: "Fix payment webhook timeouts" });
    expect(lastAgentMessage(entries)).toBe("Fixed it.");
  });

  it("opens a test chat with the member's message and keeps turns in order", () => {
    const entries = automationRunTimeline(run([
      { data: { authorId: "user-1", authorName: "Ash", text: "Try the checkout flow." }, type: "user_message" },
      { data: {}, type: "run_started" },
      { data: { items: [{ kind: "message", text: "It works." }], truncated: true }, type: "transcript" },
      { data: { authorId: "user-1", authorName: "Ash", text: "Add a test too." }, type: "user_message" },
      { data: { message: "Codex automation harness failed" }, type: "run_failed" },
    ], { trigger: { attributes: {}, provider: "manual", sourceUrl: null, title: "Try the checkout flow." } }));

    expect(entries).toEqual([
      { authorName: "Ash", createdAt: "2026-09-24T10:16:00.000Z", key: "1", kind: "user", text: "Try the checkout flow." },
      { key: "3-0", kind: "message", text: "It works." },
      { key: "3-truncated", kind: "notice", text: "Part of this transcript was too long to keep." },
      { authorName: "Ash", createdAt: "2026-09-24T10:16:00.000Z", key: "4", kind: "user", text: "Add a test too." },
      { key: "5", kind: "failure", text: "Codex automation harness failed" },
    ]);
  });

  it("does not merge tools from separate turns", () => {
    const tool = { action: "run", kind: "tool", status: "succeeded", target: "pnpm test" };
    const entries = automationRunTimeline(run([
      { data: { items: [tool], truncated: false }, type: "transcript" },
      { data: { items: [tool], truncated: false }, type: "transcript" },
    ]));

    expect(entries.map((entry) => entry.kind)).toEqual(["trigger", "activity", "activity"]);
  });

  it("times reasoning from the item before it", () => {
    const entries = automationRunTimeline(run([
      { data: { items: [
        { kind: "reasoning", observedAt: 4_000, text: "Check the handler." },
        { action: "read", kind: "tool", observedAt: 6_000, status: "succeeded", target: "src/app.ts" },
        { kind: "message", observedAt: 9_000, text: "It retries twice." },
        { action: "run", kind: "tool", observedAt: 20_000, status: "succeeded", target: "pnpm test" },
      ], startedAt: 1_000, truncated: false }, type: "transcript" },
    ]));

    const [first, , second] = entries.slice(1);
    expect(first).toMatchObject({ durationMs: 8_000, kind: "activity" });
    expect(second).toMatchObject({ durationMs: 11_000, kind: "activity" });
    expect(activityLabel(first as Extract<typeof first, { kind: "activity" }>)).toEqual({
      detail: "Ran 1 tool · 1 file read",
      title: "Thought for 8s",
    });
    expect(activityLabel(second as Extract<typeof second, { kind: "activity" }>)).toEqual({
      detail: "11s · 1 command run",
      title: "Ran 1 tool",
    });
  });
});

describe("automationRunActivity", () => {
  it("follows the latest lifecycle event", () => {
    expect(automationRunActivity(run([], { status: "pending" }))).toBe("Queued");
    expect(automationRunActivity(run([{ data: {}, type: "run_started" }], { status: "running" }))).toBe("Starting a sandbox");
    expect(automationRunActivity(run([{ data: {}, type: "run_started" }, { data: {}, type: "sandbox_ready" }], { status: "running" }))).toBe("Checking out repositories");
    expect(automationRunActivity(run([{ data: {}, type: "repositories_checked_out" }], { status: "running" }))).toBe("Thinking");
    expect(automationRunActivity(run([{ data: { resumed: true }, type: "sandbox_ready" }], { status: "running" }))).toBe("Loading repositories");
    expect(automationRunActivity(run([], { cancelRequestedAt: "2026-09-24T10:17:00.000Z", status: "running" }))).toBe("Stopping");
  });
});

describe("toolGroupSummary", () => {
  it("counts tools by kind and names queried connectors", () => {
    expect(toolGroupSummary([
      { action: "read", kind: "tool", status: "succeeded", target: "a.ts" },
      { action: "read", kind: "tool", status: "succeeded", target: "b.ts" },
      { action: "run", kind: "tool", status: "failed", target: "pnpm test" },
      { action: "query", kind: "tool", provider: "sentry", status: "succeeded", target: "get_issue" },
      { action: "query", kind: "tool", provider: "datadog", status: "succeeded", target: "search_logs" },
    ])).toBe("2 files read · 1 command run · Sentry and Datadog queried · 1 failed");
  });
});

describe("formatDuration", () => {
  it("uses tenths of a second for short tools", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(8_200)).toBe("8.2s");
    expect(formatDuration(78_000)).toBe("1m 18s");
  });
});
