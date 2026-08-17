import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { safeCustomMcpFetch } from "./custom-mcp.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  const closing = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await closing;
}

describe("custom MCP response streaming", () => {
  it("keeps a pinned connection alive until a streaming body finishes", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      setTimeout(() => response.end("data: last\n\n"), 25);
    });
    const port = await listen(server);
    try {
      const response = await safeCustomMcpFetch(`http://localhost:${port}/mcp`);
      await expect(response.text()).resolves.toBe(
        "data: first\n\ndata: last\n\n",
      );
    } finally {
      await close(server);
    }
  });

  it("releases a pinned connection when the consumer cancels", async () => {
    let responseClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.on("close", responseClosed);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      const timer = setInterval(() => response.write("data: next\n\n"), 10);
      response.on("close", () => clearInterval(timer));
    });
    const port = await listen(server);
    try {
      const response = await safeCustomMcpFetch(`http://localhost:${port}/mcp`);
      const reader = response.body?.getReader();
      await reader?.read();
      await reader?.cancel();
      await expect(
        Promise.race([
          closed.then(() => "closed"),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("timed out"), 1_000),
          ),
        ]),
      ).resolves.toBe("closed");
    } finally {
      await close(server);
    }
  });

  it("rejects a compressed response whose decoded body exceeds the limit", async () => {
    const compressed = gzipSync(Buffer.alloc(9 * 1024 * 1024, "a"));
    let requestedEncoding: string | undefined;
    const server = createServer((request, response) => {
      requestedEncoding = request.headers["accept-encoding"];
      // Ignore the client's identity preference to exercise the decoded-byte
      // limit against an untrusted server.
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
        "content-type": "application/json",
      });
      response.end(compressed);
    });
    const port = await listen(server);
    try {
      const response = await safeCustomMcpFetch(
        `http://localhost:${port}/mcp`,
        { headers: { "accept-encoding": "gzip" } },
      );

      await expect(response.arrayBuffer()).rejects.toThrow(
        "MCP response exceeds 8388608 decoded bytes",
      );
      expect(requestedEncoding).toBe("identity");
    } finally {
      await close(server);
    }
  });
});
