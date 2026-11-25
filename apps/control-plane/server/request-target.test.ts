import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "./app.js";
import { hasDotSegment } from "./request-target.js";

// Sends the request target exactly as given; Node's client does not resolve
// dot segments.
function get(port: number, target: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", path: target, port }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ body, status: response.statusCode ?? 0 }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("request targets with dot segments", () => {
  it("finds literal and percent-encoded dot segments", () => {
    for (const target of [
      "/api/webhooks/../health",
      "/api/webhooks/%2e%2e/health",
      "/api/webhooks/%2E%2E/health",
      "/api/webhooks/.%2e/health",
      "/api/webhooks/%2e./health",
      "/api/./health",
      "/api/%2e/health",
      "/api/webhooks\\..\\health",
      "/../api/health",
      "/api/health/..",
      "/api/health/%2e?x=1",
    ]) {
      expect(hasDotSegment(target), target).toBe(true);
    }
    for (const target of [
      "/",
      "/api/health",
      "/api/health?next=/../x",
      "/api/integrations/github/accounts/a..b",
      "/api/mcp/.hidden",
      "/templates/...",
      "/api/webhooks/%252e%252e/health",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect(hasDotSegment(target), target).toBe(false);
    }
  });

  describe("served over HTTP", () => {
    let server: ReturnType<typeof serve>;
    let port = 0;

    beforeAll(async () => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("rejects a request whose path resolves somewhere else", async () => {
      for (const target of [
        "/api/webhooks/%2e%2e/health",
        "/api/webhooks/../health",
        "/api/ingest/%2E%2E/health",
      ]) {
        const response = await get(port, target);
        expect(response.status, target).toBe(400);
        expect(JSON.parse(response.body), target).toEqual({ error: "Invalid request path" });
      }
    });

    it("serves ordinary paths", async () => {
      const response = await get(port, "/api/health");
      expect(response.status).toBe(200);
    });
  });
});
