import { describe, expect, it } from "vitest";
import type { OverviewAi, OverviewService } from "../telemetry-api";
import {
  aiCostCallout,
  formatCount,
  logPills,
  serviceProblems,
  suggestionPrompt,
  tracePills,
} from "./telemetry-overview-presentation";

const logs = (overrides: Partial<NonNullable<OverviewService["logs"]>> = {}): NonNullable<OverviewService["logs"]> => ({
  buckets: [],
  errors: 0,
  errorsWithoutException: 0,
  total: 1_000,
  warnings: 0,
  withTrace: 1_000,
  ...overrides,
});
const traces = (overrides: Partial<NonNullable<OverviewService["traces"]>> = {}): NonNullable<OverviewService["traces"]> => ({
  buckets: [],
  errors: 0,
  slow: 0,
  total: 400,
  ...overrides,
});
const service = (overrides: Partial<OverviewService>): OverviewService => ({
  lastSeen: "2026-10-16 11:59:00",
  logs: logs(),
  name: "checkout",
  traces: traces(),
  ...overrides,
});
const ai = (overrides: Partial<OverviewAi> = {}): OverviewAi => ({
  calls: 0,
  callsWithInput: 0,
  callsWithModel: 0,
  callsWithOutput: 0,
  callsWithoutUsage: 0,
  models: [],
  services: [],
  ...overrides,
});

describe("formatCount", () => {
  it("shows exact counts below ten thousand and compact counts above", () => {
    expect(formatCount(9_412)).toBe("9,412");
    expect(formatCount(41_300)).toBe("41.3k");
    expect(formatCount(1_100_000)).toBe("1.1M");
  });
});

describe("pills", () => {
  it("marks empty buckets, error spikes and warning spikes", () => {
    expect(
      logPills([
        { errors: 0, total: 0, warnings: 0 },
        { errors: 0, total: 100, warnings: 2 },
        { errors: 6, total: 100, warnings: 0 },
        { errors: 1, total: 100, warnings: 12 },
      ]),
    ).toEqual(["empty", "ok", "error", "warning"]);
    expect(
      tracePills([
        { errors: 0, slow: 0, total: 0 },
        { errors: 0, slow: 15, total: 100 },
        { errors: 1, slow: 0, total: 10 },
      ]),
    ).toEqual(["empty", "warning", "error"]);
  });
});

describe("serviceProblems", () => {
  it("finds nothing wrong with a service that sends linked logs and traces", () => {
    expect(serviceProblems(service({}), "24h")).toEqual([]);
  });

  it("flags a service that sends logs but no traces, with a prompt naming it", () => {
    const [problem] = serviceProblems(service({ name: "billing-worker", traces: null }), "24h");

    expect(problem).toMatchObject({ id: "no-traces", severity: "error", title: "No traces from billing-worker" });
    expect(problem!.detail).toContain("1,000 log records but no spans in the last 24 hours");
    expect(problem!.prompt).toContain("`billing-worker`");
  });

  it("flags a service that sends traces but no logs", () => {
    expect(serviceProblems(service({ logs: null }), "1h").map((problem) => problem.id)).toEqual(["no-logs"]);
  });

  it("flags error logs without exception details once there are enough of them", () => {
    expect(serviceProblems(service({ logs: logs({ errors: 9, errorsWithoutException: 9 }) }), "24h")).toEqual([]);
    const [problem] = serviceProblems(service({ logs: logs({ errors: 1_890, errorsWithoutException: 1_412 }) }), "24h");
    expect(problem).toMatchObject({ id: "no-exception-details" });
    expect(problem!.detail).toBe("1,412 of 1,890 error logs have no exception type, message or stack trace, so they can't be grouped into issues.");
  });

  it("flags logs that carry no trace ID when the service also sends traces", () => {
    const [problem] = serviceProblems(service({ logs: logs({ total: 1_000, withTrace: 200 }) }), "24h");
    expect(problem).toMatchObject({ detail: "80% of log records carry no trace ID, so they can't be found from their traces.", id: "logs-without-trace" });
    expect(serviceProblems(service({ logs: logs({ total: 1_000, withTrace: 200 }), traces: null }), "24h").map((p) => p.id)).toEqual(["no-traces"]);
  });
});

describe("aiCostCallout", () => {
  it("stays hidden when every model call reports usage", () => {
    expect(aiCostCallout(ai({ calls: 10, callsWithInput: 10, callsWithModel: 10, callsWithOutput: 10 }), "24h")).toBeNull();
  });

  it("lists the missing attributes, detected models and services", () => {
    const callout = aiCostCallout(
      ai({
        calls: 1_612,
        callsWithModel: 1_612,
        callsWithoutUsage: 1_612,
        models: [
          { calls: 1_204, model: "gpt-4.1-mini" },
          { calls: 296, model: "claude-haiku-4-5" },
          { calls: 100, model: "text-embedding-3-small" },
          { calls: 12, model: "o3" },
        ],
        services: [{ calls: 1_612, callsWithoutUsage: 1_612, service: "checkout" }],
      }),
      "24h",
    );

    expect(callout!.detail).toBe(
      "checkout made 1,612 model calls in the last 24 hours, but none report token usage. Add the missing attributes and Superlog prices every call by model and service.",
    );
    expect(callout!.attributes).toEqual([
      { key: "gen_ai.request.model", note: "found on every call", state: "found" },
      { key: "gen_ai.usage.input_tokens", note: "missing", state: "missing" },
      { key: "gen_ai.usage.output_tokens", note: "missing", state: "missing" },
    ]);
    expect(callout!.models.map((model) => model.model)).toEqual(["gpt-4.1-mini", "claude-haiku-4-5", "text-embedding-3-small"]);
    expect(callout!.prompt).toContain("`checkout`");
    expect(callout!.prompt).toContain("`gpt-4.1-mini`");
  });

  it("describes calls that report usage only some of the time", () => {
    const callout = aiCostCallout(
      ai({
        calls: 200,
        callsWithInput: 150,
        callsWithModel: 200,
        callsWithOutput: 150,
        callsWithoutUsage: 50,
        services: [
          { calls: 120, callsWithoutUsage: 20, service: "api" },
          { calls: 50, callsWithoutUsage: 20, service: "worker" },
          { calls: 30, callsWithoutUsage: 10, service: "search" },
        ],
      }),
      "1h",
    );

    expect(callout!.detail).toMatch(/^api, worker and 1 more made 200 model calls in the last hour, but 50 don't report token usage\./u);
    expect(callout!.attributes[1]).toEqual({ key: "gen_ai.usage.input_tokens", note: "on 75% of calls", state: "partial" });
  });
});

describe("suggestionPrompt", () => {
  it("hands the suggestion's detail to a coding agent", () => {
    expect(suggestionPrompt({ detail: "Wrap the call in a span.\n", subtitle: "The gap hides latency.", title: "Add a span around the Stripe call" })).toBe(
      "Add a span around the Stripe call.\n\nThe gap hides latency.\n\nWrap the call in a span.\n\nMake this change, run the project's checks, then summarize what you changed.",
    );
  });
});
