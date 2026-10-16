import type { Histogram } from "@opentelemetry/api";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requestMetrics } from "./request-metrics.js";

describe("request metrics", () => {
  it("records duration by method, route template, and status", async () => {
    const record = vi.fn();
    const histogram = { record } as unknown as Histogram;
    let time = 1_000;
    const app = new Hono()
      .use("/api/*", requestMetrics({ histogram: () => histogram, now: () => (time += 250) }))
      .get("/api/issues/:issueId", (context) => context.json({ id: context.req.param("issueId") }))
      .get("/api/broken", () => {
        throw new Error("broken");
      });

    expect((await app.request("/api/issues/issue-1")).status).toBe(200);
    expect((await app.request("/api/broken")).status).toBe(500);
    expect((await app.request("/api/missing")).status).toBe(404);

    expect(record.mock.calls).toEqual([
      [0.25, { "http.request.method": "GET", "http.response.status_code": 200, "http.route": "/api/issues/:issueId" }],
      [0.25, { "http.request.method": "GET", "http.response.status_code": 500, "http.route": "/api/broken" }],
      [0.25, { "http.request.method": "GET", "http.response.status_code": 404, "http.route": "/api/*" }],
    ]);
  });
});
