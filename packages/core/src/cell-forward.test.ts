import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchOnFreshConnection } from "./cell-forward.js";

describe("fetchOnFreshConnection", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function listen() {
    const received: Array<{ body: string; headers: IncomingHttpHeaders; method?: string }> = [];
    let connections = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ body: Buffer.concat(chunks).toString(), headers: request.headers, method: request.method });
        response.writeHead(202, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    server.on("connection", () => {
      connections += 1;
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { connections: () => connections, received, url: `http://127.0.0.1:${port}/api/webhooks/github` };
  }

  it("sends each request on its own connection", async () => {
    const server = await listen();

    for (let index = 0; index < 3; index += 1) {
      const response = await fetchOnFreshConnection(server.url, { body: new Uint8Array([1]), method: "POST" });
      await response.text();
    }

    expect(server.received).toHaveLength(3);
    expect(server.connections()).toBe(3);
  });

  it("sends the method, headers, and body and returns the answer", async () => {
    const server = await listen();
    const headers = new Headers({ "content-type": "application/json", "x-github-event": "pull_request" });

    const response = await fetchOnFreshConnection(server.url, {
      body: new TextEncoder().encode('{"action":"opened"}'),
      headers,
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(server.received[0]).toMatchObject({
      body: '{"action":"opened"}',
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      method: "POST",
    });
  });
});
