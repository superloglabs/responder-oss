import assert from "node:assert/strict";
import { test } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  countSeries,
  listAttributeKeys,
  listServices,
  queryLogs,
  queryMetrics,
  queryTraces,
} from "./query.js";

function recordingClient(queries: string[]): ClickHouseClient {
  return {
    query: async ({ query }: { query: string }) => {
      queries.push(query);
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
}

test("log and trace services come only from their own table", async () => {
  for (const signal of ["logs", "traces"] as const) {
    const queries: string[] = [];
    await listServices(recordingClient(queries), "project-1", undefined, signal);
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, new RegExp(`\\bFROM otel_${signal}\\b`));
  }
});

test("raw telemetry queries filter through the materialized project column", async () => {
  const queries: string[] = [];
  const ch = recordingClient(queries);
  const range = {
    since: "2026-07-23T00:00:00.000Z",
    until: "2026-07-23T01:00:00.000Z",
  };

  await queryLogs(ch, "project-1", { range, limit: 10 });
  await queryTraces(ch, "project-1", { range, limit: 10 });
  await queryMetrics(ch, "project-1", { range, limit: 10 });
  await listServices(ch, "project-1", range);
  await listAttributeKeys(ch, "project-1", range);
  await countSeries(ch, "project-1", "logs", { range }, undefined, {
    n: 1,
    unit: "HOUR",
  });

  const logAndTraceQueries = queries.filter((query) =>
    /\bFROM otel_(logs|traces)\b/.test(query),
  );
  assert.ok(logAndTraceQueries.length > 0);
  for (const query of logAndTraceQueries) {
    assert.match(query, /SuperlogProjectId = \{organizationId:String\}/);
    assert.doesNotMatch(
      query,
      /ResourceAttributes\['superlog\.project_id'\] = \{organizationId:String\}/,
    );
  }

  const metricQueries = queries.filter((query) =>
    /\bFROM otel_metrics_/.test(query),
  );
  assert.ok(metricQueries.length > 0);
  for (const query of metricQueries) {
    assert.match(
      query,
      /ResourceAttributes\['superlog\.project_id'\] = \{organizationId:String\}/,
    );
  }
});
