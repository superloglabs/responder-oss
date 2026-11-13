import { describe, expect, it, vi } from "vitest";
import type { RailwayFetch } from "../../integrations/railway.js";
import type { RailwayLogLine } from "./railway-logs.js";
import { pullRailwaySource, readRailwayLogWindow } from "./railway-pull.js";

const now = new Date("2026-11-13T10:00:00Z");

function log(timestamp: string, message = "hello", serviceId = "svc-api"): RailwayLogLine {
  return {
    attributes: [],
    message,
    severity: "info",
    tags: { deploymentId: "dep-1", deploymentInstanceId: "replica-1", projectId: "project-1", serviceId },
    timestamp,
  };
}

type Variables = { anchor: string; environmentId: string; limit: number; start: string };

// A Railway API that answers the window query from `logs` the way Railway
// does: the newest `limit` logs at or before the anchor (to the
// millisecond), plus one older log, oldest first.
function railway(logs: RailwayLogLine[], services: Record<string, string> = { "svc-api": "api" }) {
  const calls: Variables[] = [];
  const fetchFn = vi.fn<RailwayFetch>(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    if (body.query.includes("services(")) {
      return Response.json({
        data: { project: { services: { edges: Object.entries(services).map(([id, name]) => ({ node: { id, name } })) } } },
      });
    }
    const variables = body.variables as Variables;
    calls.push(variables);
    const millis = (value: string) => Math.floor(Date.parse(value));
    const inWindow = logs
      .filter((item) => millis(item.timestamp) >= millis(variables.start) && millis(item.timestamp) <= millis(variables.anchor))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return Response.json({ data: { logs: inWindow.slice(-(variables.limit + 1)) } });
  });
  return { calls, fetch: fetchFn };
}

describe("readRailwayLogWindow", () => {
  it("pages back from the end until the window is read", async () => {
    const logs = Array.from({ length: 2_500 }, (_, index) =>
      log(new Date(Date.parse("2026-11-13T09:55:00Z") + index * 10).toISOString().replace("Z", "000000Z"), `line ${index}`));
    const api = railway(logs);

    const result = await readRailwayLogWindow({
      accessToken: "token",
      end: "2026-11-13T09:59:40.000Z",
      environmentId: "env-prod",
      fetch: api.fetch,
      start: "2026-11-13T09:55:00.000Z",
    });

    expect(result.truncated).toBe(false);
    // The log exactly at the start was read by the previous pull.
    expect(result.lines).toHaveLength(2_499);
    expect(new Set(result.lines.map((line) => line.message)).size).toBe(2_499);
    expect(api.calls.map((call) => call.anchor)).toEqual([
      "2026-11-13T09:59:40.000Z",
      logs[1_500]!.timestamp,
      logs[501]!.timestamp,
    ]);
  });
});

describe("pullRailwaySource", () => {
  it("starts five minutes back, names services, and moves the cursor", async () => {
    const api = railway([
      log("2026-11-13T09:54:00.000000000Z", "too old"),
      log("2026-11-13T09:58:00.123456789Z", "Error: boom", "svc-api"),
      log("2026-11-13T09:59:50.000000000Z", "not readable yet"),
    ]);
    const forward = vi.fn<(payload: unknown) => Promise<boolean>>(async () => true);

    const result = await pullRailwaySource({
      accessToken: "token",
      environmentId: "env-prod",
      fetch: api.fetch,
      forward,
      now,
      state: { environmentName: "production", projectName: "shop", services: {} },
    });

    expect(api.calls[0]).toMatchObject({ anchor: "2026-11-13T09:59:40.000Z", environmentId: "env-prod", start: "2026-11-13T09:55:00.000Z" });
    expect(result).toMatchObject({ error: null, logs: 1, received: true, truncated: false });
    expect(result.state).toMatchObject({
      logsCursor: "2026-11-13T09:59:40.000Z",
      services: { "svc-api": "api" },
      servicesReadAt: now.toISOString(),
    });
    const payload = forward.mock.calls[0]![0] as { resourceLogs: Array<{ resource: { attributes: unknown[] } }> };
    expect(payload.resourceLogs[0]!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "api" } });
  });

  it("keeps the cursor when the collector refuses the logs", async () => {
    const api = railway([log("2026-11-13T09:59:00Z")]);
    const state = { logsCursor: "2026-11-13T09:58:40.000Z", services: { "svc-api": "api" }, servicesReadAt: now.toISOString() };

    const result = await pullRailwaySource({
      accessToken: "token",
      environmentId: "env-prod",
      fetch: api.fetch,
      forward: async () => false,
      now,
      state,
    });

    expect(result.error).toContain("did not accept");
    expect(result.received).toBe(false);
    expect(result.state.logsCursor).toBe("2026-11-13T09:58:40.000Z");
  });

  it("reports a Railway error and skips ahead after an hour behind", async () => {
    const failing = vi.fn<RailwayFetch>(async () => Response.json({ errors: [{ message: "Not Authorized" }] }));
    const result = await pullRailwaySource({
      accessToken: "token",
      environmentId: "env-prod",
      fetch: failing,
      forward: async () => true,
      now,
      state: { logsCursor: "2026-11-13T07:00:00.000Z", services: {} },
    });
    expect(result.error).toBe("Logs: Railway API error: Not Authorized");
    const sent = JSON.parse(String(failing.mock.calls[0]![1].body)) as { variables: Variables };
    expect(sent.variables.start).toBe("2026-11-13T09:00:00.000Z");
  });
});
