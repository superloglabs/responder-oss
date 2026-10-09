import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import {
  getUsageHistory,
  sandboxHoursByDay,
  parseUsageHistoryDays,
  usageHistoryDays,
  usageHistoryStart,
  usageSources,
} from "./usage-history.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

const dialect = new PgDialect();

// Each `select` resolves to the next result set, whatever the query chain.
// `filters` holds each query's rendered WHERE clause, in `select` order.
function fakeDatabase(results: unknown[][]) {
  const remaining = [...results];
  const filters: string[] = [];
  const select = vi.fn(() => {
    const rows = remaining.shift() ?? [];
    const index = filters.push("") - 1;
    const chain: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
      where: (condition: SQL) => {
        filters[index] = dialect.sqlToQuery(condition).sql;
        return chain;
      },
    };
    for (const method of ["from", "leftJoin", "groupBy"]) chain[method] = () => chain;
    return chain;
  });
  vi.mocked(getDatabase).mockReturnValue({ select } as unknown as ReturnType<typeof getDatabase>);
  return { filters, select };
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

describe("sandboxHoursByDay", () => {
  const since = new Date("2026-10-03T00:00:00Z");

  it("splits a period that crosses midnight between both days", () => {
    expect(sandboxHoursByDay(
      new Date("2026-10-08T23:30:00Z"),
      new Date("2026-10-09T01:00:00Z"),
      since,
    )).toEqual([
      { day: "2026-10-08", hours: 0.5 },
      { day: "2026-10-09", hours: 1 },
    ]);
  });

  it("counts only the part of a period after the start of the range", () => {
    expect(sandboxHoursByDay(
      new Date("2026-10-02T23:00:00Z"),
      new Date("2026-10-03T00:15:00Z"),
      since,
    )).toEqual([{ day: "2026-10-03", hours: 0.25 }]);
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
    const { filters, select } = fakeDatabase([
      [
        { endedAt: "2026-10-08T11:30:00Z", source: "automation-1", startedAt: new Date("2026-10-08T10:00:00Z") },
        { endedAt: new Date("2026-10-09T00:30:00Z"), source: "tag_mode", startedAt: new Date("2026-10-09T00:00:00Z") },
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
    // Only what billing charges: billable, settled, Responder-funded, not waived.
    const [sandbox, automationModel, agentModel] = filters;
    expect(sandbox).toContain('"sandbox_usage"."organization_id" = $');
    expect(sandbox).toContain('"sandbox_usage"."billable" = $');
    expect(sandbox).toContain('"sandbox_usage"."waived_at" is null');
    expect(sandbox).toContain('coalesce("sandbox_usage"."stopped_at", "sandbox_usage"."heartbeat_at") > $');
    expect(automationModel).toContain('"automation_model_usage"."inference_source" = $');
    expect(automationModel).toContain('"automation_model_usage"."completed_at" is not null');
    expect(automationModel).toContain('"automation_model_usage"."waived_at" is null');
    expect(agentModel).toContain('"agent_model_usage"."billable" = $');
    expect(agentModel).toContain('"agent_model_usage"."waived_at" is null');
  });

  it("groups usage of automations that no longer exist", async () => {
    fakeDatabase([
      [],
      [
        { day: "2026-10-09", micros: "1000000", source: "automation-gone-1" },
        { day: "2026-10-09", micros: "2000000", source: "automation-gone-2" },
      ],
      [],
      [],
    ]);

    const history = await getUsageHistory({
      days: 7,
      now: new Date("2026-10-09T12:00:00Z"),
      organizationId: "organization-1",
    });

    expect(history.points).toEqual([
      { aiCharge: 3, day: "2026-10-09", machineHours: 0, source: "deleted_automation" },
    ]);
    expect(history.sources).toEqual({ deleted_automation: { kind: "deleted_automation" } });
  });

  it("reads only automation usage for one automation", async () => {
    const { filters, select } = fakeDatabase([[], []]);

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
    for (const filter of filters) expect(filter).toContain('"automation_runs"."automation_id" = $');
    expect(filters[0]).toContain('"sandbox_usage"."workload" = $');
  });
});
