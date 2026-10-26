import { describe, expect, it } from "vitest";
import type { OverviewAi, OverviewService } from "../telemetry-api";
import {
  aiCostCallout,
  formatCount,
  logPills,
  serviceProblems,
  suggestionPrompt,
  tracePills,
  withOverviewDetails,
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
  completedCalls: 0,
  completedGenerations: 0,
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
        { errors: 0, requests: 0, slow: 0, total: 0 },
        { errors: 0, requests: 20, slow: 3, total: 400 },
        { errors: 1, requests: 2, slow: 0, total: 10 },
        { errors: 0, requests: 0, slow: 0, total: 400 },
      ]),
    ).toEqual(["empty", "warning", "error", "ok"]);
  });
});

describe("withOverviewDetails", () => {
  const emptyBuckets = () => Array.from({ length: 48 }, () => ({ errors: 0, requests: 0, slow: 0, total: 10 }));
  const overview = {
    ai: null,
    bucketSeconds: 1_800,
    services: [
      service({ logs: logs({ errorsWithoutException: null, withTrace: null }), name: "checkout", traces: traces({ buckets: emptyBuckets(), slow: null }) }),
      service({ logs: logs({ errorsWithoutException: null, withTrace: null }), name: "billing", traces: traces({ buckets: emptyBuckets(), slow: null }) }),
    ],
  };

  it("fills in the counts that arrived, with zero for services they did not mention", () => {
    const merged = withOverviewDetails(overview, {
      ai: ai({ calls: 3 }),
      errorsWithoutException: { checkout: 7 },
      requests: [
        { bucket: 2, requests: 20, service: "checkout", slow: 3 },
        { bucket: 4, requests: 5, service: "checkout", slow: 1 },
      ],
      withTrace: { billing: 900 },
    });

    expect(merged.ai).toMatchObject({ calls: 3 });
    const [checkout, billing] = merged.services;
    expect(checkout!.logs).toMatchObject({ errorsWithoutException: 7, withTrace: 0 });
    expect(checkout!.traces!.slow).toBe(4);
    expect(checkout!.traces!.buckets[2]).toEqual({ errors: 0, requests: 20, slow: 3, total: 10 });
    expect(billing!.logs).toMatchObject({ errorsWithoutException: 0, withTrace: 900 });
    expect(billing!.traces!.slow).toBe(0);
    expect(overview.services[0]!.traces!.buckets[2]!.requests).toBe(0);
  });

  it("keeps a count that ran out of time unknown", () => {
    const merged = withOverviewDetails(overview, { ai: null, errorsWithoutException: null, requests: null, withTrace: null });

    expect(merged.services[0]!.logs).toMatchObject({ errorsWithoutException: null, withTrace: null });
    expect(merged.services[0]!.traces!.slow).toBeNull();
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

  it("skips the checks whose counts ran out of time", () => {
    expect(serviceProblems(service({ logs: logs({ errors: 1_890, errorsWithoutException: null, withTrace: null }) }), "24h")).toEqual([]);
  });
});

describe("aiCostCallout", () => {
  it("stays hidden when every model call reports usage, or the calls were not counted", () => {
    expect(
      aiCostCallout(ai({ calls: 10, callsWithInput: 10, callsWithModel: 10, callsWithOutput: 10, completedCalls: 10, completedGenerations: 10 }), "24h"),
    ).toBeNull();
    expect(aiCostCallout(null, "24h")).toBeNull();
  });

  it("lists the missing attributes, detected models and services", () => {
    const callout = aiCostCallout(
      ai({
        calls: 1_612,
        callsWithModel: 1_612,
        callsWithoutUsage: 1_612,
        completedCalls: 1_612,
        completedGenerations: 1_512,
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
      "checkout completed 1,612 model calls in the last 24 hours, but none report token usage. Add the missing attributes and Superlog prices every call by model and service.",
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
        completedCalls: 200,
        completedGenerations: 200,
        services: [
          { calls: 120, callsWithoutUsage: 20, service: "api" },
          { calls: 50, callsWithoutUsage: 20, service: "worker" },
          { calls: 30, callsWithoutUsage: 10, service: "search" },
        ],
      }),
      "1h",
    );

    expect(callout!.detail).toMatch(/^api, worker and 1 more completed 200 model calls in the last hour, but 50 don't report token usage\./u);
    expect(callout!.attributes[1]).toEqual({ key: "gen_ai.usage.input_tokens", note: "on 75% of calls", state: "partial" });
  });

  it("does not expect token counts from failed calls or output tokens from embeddings", () => {
    const callout = aiCostCallout(
      ai({
        calls: 2_032,
        callsWithInput: 1_826,
        callsWithModel: 2_032,
        callsWithOutput: 1_699,
        callsWithoutUsage: 10,
        completedCalls: 1_836,
        completedGenerations: 1_699,
        services: [{ calls: 2_032, callsWithoutUsage: 10, service: "api" }],
      }),
      "24h",
    );

    expect(callout!.detail).toMatch(/^api completed 1,836 model calls in the last 24 hours, but 10 don't report token usage\./u);
    expect(callout!.attributes).toEqual([
      { key: "gen_ai.request.model", note: "found on every call", state: "found" },
      { key: "gen_ai.usage.input_tokens", note: "on 99% of calls", state: "partial" },
      { key: "gen_ai.usage.output_tokens", note: "found on every call", state: "found" },
    ]);
    expect(aiCostCallout(ai({ calls: 30, callsWithModel: 30, callsWithInput: 30, completedCalls: 30 }), "24h")).toBeNull();
  });

  it("leaves out output tokens when every completed call is an embedding", () => {
    const callout = aiCostCallout(
      ai({ calls: 40, callsWithModel: 40, callsWithoutUsage: 40, completedCalls: 40, services: [{ calls: 40, callsWithoutUsage: 40, service: "search" }] }),
      "24h",
    );

    expect(callout!.attributes.map((attribute) => attribute.key)).toEqual(["gen_ai.request.model", "gen_ai.usage.input_tokens"]);
  });
});

describe("suggestionPrompt", () => {
  it("hands the suggestion's detail to a coding agent", () => {
    expect(suggestionPrompt({ detail: "Wrap the call in a span.\n", subtitle: "The gap hides latency.", title: "Add a span around the Stripe call" })).toBe(
      "Add a span around the Stripe call.\n\nThe gap hides latency.\n\nWrap the call in a span.\n\nMake this change, run the project's checks, then summarize what you changed.",
    );
  });
});
