import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { listTelemetryAlertEpisodes, listTelemetryAlertIntervals } from "./telemetry-alerts.js";
const state = vi.hoisted(() => ({ where: undefined as unknown, limited: false, rows: [] as { startedAt: Date; endedAt: Date | null }[] }));
vi.mock("./client.js", () => ({ getDatabase: () => {
  const query = { select: () => query, from: () => query, where: (condition: unknown) => { state.where = condition; return query; },
    offset: () => query, orderBy: () => query, limit: async () => { state.limited = true; return []; },
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(state.rows)) };
  return query;
} }));

describe("activation history intervals", () => {
  it("includes ongoing and overlapping activations before the history cutoff", async () => {
    await listTelemetryAlertEpisodes("alert", 50, { since: new Date("2026-10-01T00:00:00Z") });
    const { sql } = new PgDialect().sqlToQuery(state.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql).toContain('"ended_at" is null');
    expect(sql).toContain('"ended_at" >=');
  });
  it("reads all overlapping chart intervals without a history page limit", async () => {
    state.limited = false;
    state.rows = Array.from({ length: 60 }, (_, index) => ({ startedAt: new Date(Date.UTC(2026, 9, 1, 0, index * 2)), endedAt: new Date(Date.UTC(2026, 9, 1, 0, index * 2 + 1)) }));
    const intervals = await listTelemetryAlertIntervals("alert", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-02T00:00:00Z"));
    expect(intervals).toHaveLength(60);
    expect(state.limited).toBe(false);
    const { sql } = new PgDialect().sqlToQuery(state.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql).toContain('"ended_at" is null');
    expect(sql).toContain('"started_at" <=');
  });
});
