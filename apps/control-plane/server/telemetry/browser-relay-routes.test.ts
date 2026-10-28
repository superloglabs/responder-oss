import { describe, expect, it, vi } from "vitest";
import { createBrowserRelayRoutes, type BrowserRelayDependencies } from "./browser-relay-routes.js";

function routes(overrides: Partial<BrowserRelayDependencies> = {}) {
  const forward = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('{"partialSuccess":{}}', { headers: { "content-type": "application/json" }, status: 200 }),
  );
  const app = createBrowserRelayRoutes({
    endpoint: (signal) => `https://superlog.sh/api/ingest/v1/${signal}`,
    forward,
    headers: () => ({ Authorization: "Bearer sl_key" }),
    signedIn: async () => true,
    ...overrides,
  });
  return { app, forward };
}

const body = JSON.stringify({ resourceSpans: [] });

describe("browser telemetry relay", () => {
  it("forwards signed-in browser traces with the server's ingest headers", async () => {
    const { app, forward } = routes();
    const response = await app.request("/v1/traces", {
      body,
      headers: { "content-type": "application/json; charset=utf-8" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ partialSuccess: {} });
    expect(forward).toHaveBeenCalledWith("https://superlog.sh/api/ingest/v1/traces", {
      body: expect.any(ArrayBuffer),
      headers: { Authorization: "Bearer sl_key", "content-type": "application/json" },
      method: "POST",
    });
    expect(new TextDecoder().decode(forward.mock.calls[0]![1]!.body as ArrayBuffer)).toBe(body);
  });

  it("forwards browser error logs to the server's logs endpoint", async () => {
    const { app, forward } = routes();
    const response = await app.request("/v1/logs", {
      body: JSON.stringify({ resourceLogs: [] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(forward).toHaveBeenCalledWith("https://superlog.sh/api/ingest/v1/logs", expect.objectContaining({ method: "POST" }));
  });

  it("answers 404 for signals it does not relay", async () => {
    const { app, forward } = routes();
    const response = await app.request("/v1/metrics", { body, headers: { "content-type": "application/json" }, method: "POST" });
    expect(response.status).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it("answers 404 when the server exports no telemetry", async () => {
    const { app, forward } = routes({ endpoint: () => null });
    const response = await app.request("/v1/traces", { body, headers: { "content-type": "application/json" }, method: "POST" });
    expect(response.status).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses visitors who are not signed in", async () => {
    const { app, forward } = routes({ signedIn: async () => false });
    const response = await app.request("/v1/traces", { body, headers: { "content-type": "application/json" }, method: "POST" });
    expect(response.status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses bodies that are not OTLP", async () => {
    const { app, forward } = routes();
    const response = await app.request("/v1/traces", { body, headers: { "content-type": "text/plain" }, method: "POST" });
    expect(response.status).toBe(415);
    expect(forward).not.toHaveBeenCalled();
  });

  it("answers 503 when the endpoint cannot be reached", async () => {
    const { app } = routes({ forward: vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNREFUSED")) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await app.request("/v1/traces", { body, headers: { "content-type": "application/json" }, method: "POST" });
    expect(response.status).toBe(503);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("browser_telemetry_forward_failed"));
    warn.mockRestore();
  });
});
