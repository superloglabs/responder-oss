import { describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import {
  getUsageHistory,
  parseUsageHistoryDays,
  usageHistoryDays,
  usageHistoryStart,
  usageSources,
} from "./usage-history.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

// Each `select` resolves to the next result set, whatever the query chain.
function fakeDatabase(results: unknown[][]) {
  const remaining = [...results];
  const select = vi.fn(() => {
    const rows = remaining.shift() ?? [];
    const chain: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    for (const method of ["from", "leftJoin", "where", "groupBy"]) chain[method] = () => chain;
    return chain;
  });
  vi.mocked(getDatabase).mockReturnValue({ select } as unknown as ReturnType<typeof getDatabase>);
  return select;
}

describe("usage history ranges", () => {
  it("starts at the beginning of the first UTC day and lists every day", () => {
    const start = usageHistoryStart(7, new Date("2026-10-09T23:30:00Z"));

    expect(start.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(usageHistoryDays(start, 7)).toEqual([
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
    ]);
  });

  it("accepts only the offered ranges", () => {
    expect(parseUsageHistoryDays("7")).toBe(7);
    expect(parseUsageHistoryDays("90")).toBe(90);
    expect(parseUsageHistoryDays("365")).toBe(30);
    expect(parseUsageHistoryDays(undefined)).toBe(30);
  });
});

describe("usageSources", () => {
  it("names automations and treats unknown automation IDs as deleted", () => {
    expect(usageSources(
      [{ source: "automation-1" }, { source: "tag_mode" }, { source: "automation-2" }, { source: "tag_mode" }],
      [{ id: "automation-1", name: "Sentry triage" }],
    )).toEqual({
      "automation-1": { automationId: "automation-1", kind: "automation", name: "Sentry triage" },
      "automation-2": { kind: "deleted_automation" },
      tag_mode: { kind: "tag_mode" },
    });
  });
});

describe("getUsageHistory", () => {
  it("merges sandbox time and model charges by day and source", async () => {
    const select = fakeDatabase([
      [
        { day: "2026-10-08", seconds: "5400", source: "automation-1" },
        { day: "2026-10-09", seconds: "1800", source: "tag_mode" },
      ],
      [{ day: "2026-10-08", micros: "1250000", source: "automation-1" }],
      [
        { day: "2026-10-09", micros: "500000", source: "tag_mode" },
        { day: "2026-10-09", micros: "250000", source: "pull_requests" },
      ],
      [{ id: "automation-1", name: "Sentry triage" }],
    ]);

    const history = await getUsageHistory({
      days: 7,
      now: new Date("2026-10-09T12:00:00Z"),
      organizationId: "organization-1",
    });

    expect(select).toHaveBeenCalledTimes(4);
    expect(history.days).toHaveLength(7);
    expect(history.points).toEqual([
      { aiCharge: 1.25, day: "2026-10-08", machineHours: 1.5, source: "automation-1" },
      { aiCharge: 0.25, day: "2026-10-09", machineHours: 0, source: "pull_requests" },
      { aiCharge: 0.5, day: "2026-10-09", machineHours: 0.5, source: "tag_mode" },
    ]);
    expect(history.sources).toEqual({
      "automation-1": { automationId: "automation-1", kind: "automation", name: "Sentry triage" },
      pull_requests: { kind: "pull_requests" },
      tag_mode: { kind: "tag_mode" },
    });
  });

  it("reads only automation usage for one automation", async () => {
    const select = fakeDatabase([[], []]);

    const history = await getUsageHistory({
      automationId: "automation-1",
      days: 30,
      now: new Date("2026-10-09T12:00:00Z"),
      organizationId: "organization-1",
    });

    // Sandbox time and automation model usage; no agent usage or names.
    expect(select).toHaveBeenCalledTimes(2);
    expect(history).toEqual({ days: expect.any(Array), points: [], sources: {} });
    expect(history.days).toHaveLength(30);
  });
});
