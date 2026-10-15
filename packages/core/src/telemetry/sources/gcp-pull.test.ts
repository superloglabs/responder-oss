import { describe, expect, it, vi } from "vitest";
import { pullGcpSource, type GcpRequest } from "./gcp-pull.js";
import { gcpMetricTypes } from "./gcp-telemetry.js";

const now = new Date("2026-10-15T10:00:00Z");

function entry(timestamp: string) {
  return { resource: { type: "global" }, textPayload: "hello", timestamp };
}

describe("pullGcpSource", () => {
  it("reads logs from five minutes back, then from the cursor", async () => {
    const request = vi.fn<GcpRequest>(async (input) =>
      input.url.includes("entries:list") ? { entries: [entry("2026-10-15T09:57:00.5Z")] } : { timeSeries: [] },
    );
    const forward = vi.fn(async () => true);

    const first = await pullGcpSource({ forward, gcpProjectId: "shop-prod", now, request, state: {} });

    const body = request.mock.calls[0]![0].data as { filter: string; resourceNames: string[] };
    expect(body.resourceNames).toEqual(["projects/shop-prod"]);
    expect(body.filter).toContain('timestamp > "2026-10-15T09:55:00.000Z" AND timestamp <= "2026-10-15T09:59:00.000Z"');
    expect(body.filter).toContain('NOT log_id("cloudaudit.googleapis.com/data_access")');
    expect(forward).toHaveBeenCalledWith("logs", expect.objectContaining({ resourceLogs: expect.any(Array) }));
    expect(first).toMatchObject({ error: null, logs: 1, received: true });
    expect(first.state.logsCursor).toBe("2026-10-15T09:59:00.000Z");
    expect(first.state.metricsPulledAt).toBe(now.toISOString());

    request.mockClear();
    const next = await pullGcpSource({
      forward,
      gcpProjectId: "shop-prod",
      now: new Date(now.getTime() + 60_000),
      request,
      state: first.state,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect((request.mock.calls[0]![0].data as { filter: string }).filter).toContain('timestamp > "2026-10-15T09:59:00.000Z"');
    expect(next.state.metricsPulledAt).toBe(now.toISOString());
  });

  it("saves the page token at the page limit and continues it on the next pull", async () => {
    let page = 0;
    const request = vi.fn<GcpRequest>(async (input) => {
      if (!input.url.includes("entries:list")) return { timeSeries: [] };
      page += 1;
      return { entries: [entry(`2026-10-15T09:56:${String(page).padStart(2, "0")}Z`)], nextPageToken: `p${page}` };
    });

    const first = await pullGcpSource({ forward: async () => true, gcpProjectId: "shop-prod", now, request, state: { metricsPulledAt: now.toISOString() } });

    expect(first.logs).toBe(10);
    expect(first.state.logsCursor).toBe("2026-10-15T09:56:10Z");
    expect(first.state.logsPage).toEqual({ end: "2026-10-15T09:59:00.000Z", start: "2026-10-15T09:55:00.000Z", token: "p10" });

    request.mockImplementation(async () => ({ entries: [entry("2026-10-15T09:58:00Z")] }));
    const next = await pullGcpSource({ forward: async () => true, gcpProjectId: "shop-prod", now: new Date(now.getTime() + 60_000), request, state: first.state });

    const body = request.mock.calls.at(-1)![0].data as { filter: string; pageToken: string };
    expect(body.pageToken).toBe("p10");
    expect(body.filter).toContain('timestamp > "2026-10-15T09:55:00.000Z" AND timestamp <= "2026-10-15T09:59:00.000Z"');
    expect(next.state.logsPage).toBeUndefined();
    expect(next.state.logsCursor).toBe("2026-10-15T09:59:00.000Z");
  });

  it("restarts the saved window when its page token no longer works", async () => {
    const request = vi.fn<GcpRequest>(async (input) => {
      if ((input.data as { pageToken?: string }).pageToken) throw new Error("Invalid page token");
      return { entries: [] };
    });
    const state = {
      logsCursor: "2026-10-15T09:58:30Z",
      logsPage: { end: "2026-10-15T09:58:00.000Z", start: "2026-10-15T09:57:00.000Z", token: "old" },
      metricsPulledAt: now.toISOString(),
    };

    const result = await pullGcpSource({ forward: async () => true, gcpProjectId: "shop-prod", now, request, state });

    expect(result.error).toBeNull();
    const restarted = request.mock.calls.at(-1)![0].data as { filter: string; pageToken?: string };
    expect(restarted.filter).toContain('timestamp > "2026-10-15T09:57:00.000Z" AND timestamp <= "2026-10-15T09:58:00.000Z"');
    expect(restarted.pageToken).toBeUndefined();
    expect(result.state.logsPage).toBeUndefined();
  });

  it("does not move a metric cursor past pages it has not read", async () => {
    const request = vi.fn<GcpRequest>(async (input) => {
      if (input.url.includes("entries:list")) return { entries: [] };
      return { nextPageToken: "more", timeSeries: [] };
    });

    const result = await pullGcpSource({ forward: async () => true, gcpProjectId: "shop-prod", now, request, state: {} });

    expect(result.state.metricsCursors).toEqual({});
    expect(result.state.metricsPages[gcpMetricTypes[0]]).toEqual({ end: "2026-10-15T09:55:00.000Z", start: "2026-10-15T09:45:00.000Z", token: "more" });
  });

  it("keeps the cursor when the logs are not delivered", async () => {
    const state = { logsCursor: "2026-10-15T09:58:00Z", metricsPulledAt: now.toISOString() };
    const result = await pullGcpSource({
      forward: async () => false,
      gcpProjectId: "shop-prod",
      now,
      request: async () => ({ entries: [entry("2026-10-15T09:58:30Z")] }),
      state,
    });

    expect(result.error).toContain("did not accept");
    expect(result.state.logsCursor).toBe("2026-10-15T09:58:00Z");
    expect(result.received).toBe(false);
  });

  it("skips ahead when the cursor is more than an hour old", async () => {
    const request = vi.fn<GcpRequest>(async () => ({ entries: [] }));
    await pullGcpSource({ forward: async () => true, gcpProjectId: "shop-prod", now, request, state: { logsCursor: "2026-10-14T00:00:00Z", metricsPulledAt: now.toISOString() } });

    expect((request.mock.calls[0]![0].data as { filter: string }).filter).toContain('timestamp > "2026-10-15T09:00:00.000Z"');
  });

  it("reads each metric type and reports only when every type fails", async () => {
    const request = vi.fn<GcpRequest>(async (input) => {
      if (input.url.includes("entries:list")) return { entries: [] };
      if (input.url.includes(encodeURIComponent("run.googleapis.com/request_count"))) {
        return { timeSeries: [{ metric: { type: "run.googleapis.com/request_count" }, metricKind: "DELTA", points: [{ interval: { endTime: "2026-10-15T09:54:00Z" }, value: { int64Value: "3" } }] }] };
      }
      return { timeSeries: [] };
    });
    const forward = vi.fn(async () => true);

    const result = await pullGcpSource({ forward, gcpProjectId: "shop-prod", now, request, state: {} });

    expect(request).toHaveBeenCalledTimes(1 + gcpMetricTypes.length);
    expect(request.mock.calls[1]![0].url).toContain("/projects/shop-prod/timeSeries?");
    expect(forward).toHaveBeenCalledWith("metrics", expect.objectContaining({ resourceMetrics: expect.any(Array) }));
    expect(result.points).toBe(1);
    expect(result.state.metricsCursors["run.googleapis.com/request_count"]).toBe("2026-10-15T09:55:00.000Z");

    const denied = await pullGcpSource({
      forward,
      gcpProjectId: "shop-prod",
      now,
      request: async (input) => {
        if (input.url.includes("entries:list")) return { entries: [] };
        throw Object.assign(new Error("403"), { response: { data: { error: { message: "Permission denied" } } } });
      },
      state: {},
    });
    expect(denied.error).toContain("Metrics:");
    expect(denied.error).toContain("Permission denied");
  });
});
