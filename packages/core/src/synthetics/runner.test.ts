import http from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeSyntheticRequest, runSyntheticAttempt, runSyntheticCheck } from "./runner.js";
import type { SyntheticRequest } from "./types.js";

let server: http.Server;
// 256 MB of zeros, compressed to a few hundred bytes.
const bomb = brotliCompressSync(Buffer.alloc(256 * 1024 * 1024), { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
let origin: string;
const seen: Array<{ headers: http.IncomingHttpHeaders; method: string; url: string }> = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    seen.push({ headers: request.headers, method: request.method!, url: request.url! });
    const url = new URL(request.url!, "http://local");
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    } else if (url.pathname === "/gzip") {
      response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("compressed hello"));
    } else if (url.pathname === "/empty-gzip") {
      response.writeHead(request.method === "HEAD" ? 200 : 204, { "content-encoding": "gzip" }).end();
    } else if (url.pathname === "/empty-200-gzip") {
      response.writeHead(200, { "content-encoding": "gzip" }).end();
    } else if (url.pathname === "/bomb") {
      response.writeHead(200, { "content-encoding": "br" }).end(bomb);
    } else if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/health" }).end();
    } else if (url.pathname === "/loop") {
      response.writeHead(302, { location: "/loop" }).end();
    } else if (url.pathname === "/elsewhere") {
      response.writeHead(307, { location: url.searchParams.get("to")! }).end();
    } else if (url.pathname === "/large") {
      response.writeHead(200).end("x".repeat(2 * 1024 * 1024));
    } else if (url.pathname === "/slow") {
      setTimeout(() => response.writeHead(200).end("late"), 3_000).unref();
    } else if (url.pathname === "/echo") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => response.writeHead(201).end(body));
    } else {
      response.writeHead(503).end("down");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function request(path: string, overrides: Partial<SyntheticRequest> = {}): SyntheticRequest {
  return { body: null, followRedirects: true, headers: [], method: "GET", timeoutMs: 2_000, url: `${origin}${path}`, ...overrides };
}

describe("synthetic runner", () => {
  it("makes the request and times each phase", async () => {
    const execution = await executeSyntheticRequest(request("/health"), { allowLocal: true });

    expect(execution.response).toMatchObject({ body: '{"status":"ok"}', redirects: 0, statusCode: 200 });
    expect(execution.response.headers["content-type"]).toBe("application/json");
    expect(execution.timings.tlsMs).toBe(0);
    const phases = Object.values(execution.timings).reduce((sum, value) => sum + value, 0);
    expect(phases).toBeLessThanOrEqual(execution.durationMs + 1);
    expect(seen.at(-1)?.headers["user-agent"]).toMatch(/^Superlog-Synthetics/u);
  });

  it("sends the method, headers and body", async () => {
    const execution = await executeSyntheticRequest(
      request("/echo", { body: '{"a":1}', headers: [{ name: "X-Token", secret: true, value: "s3cret" }], method: "POST" }),
      { allowLocal: true },
    );
    expect(execution.response).toMatchObject({ body: '{"a":1}', statusCode: 201 });
    expect(seen.at(-1)).toMatchObject({ headers: { "x-token": "s3cret" }, method: "POST" });
  });

  it("decodes compressed bodies and caps long ones", async () => {
    expect((await executeSyntheticRequest(request("/gzip"), { allowLocal: true })).response.fullBody).toBe("compressed hello");
    const large = await executeSyntheticRequest(request("/large"), { allowLocal: true });
    expect(large.response).toMatchObject({ bodyBytes: 1024 * 1024, bodyTruncated: true });
    expect(large.response.body).toHaveLength(4_096);
  });

  it("reads empty encoded bodies as empty", async () => {
    for (const [path, method] of [["/empty-gzip", "HEAD"], ["/empty-gzip", "GET"], ["/empty-200-gzip", "GET"]] as const) {
      const execution = await executeSyntheticRequest(request(path, { method }), { allowLocal: true });
      expect(execution.response).toMatchObject({ bodyBytes: 0, fullBody: "" });
    }
  });

  it("stops decoding a compressed body at the cap", async () => {
    const execution = await executeSyntheticRequest(request("/bomb"), { allowLocal: true });
    expect(execution.response).toMatchObject({ bodyBytes: 1024 * 1024, bodyTruncated: true });
  });

  it("follows redirects only when asked, and stops a loop", async () => {
    expect((await executeSyntheticRequest(request("/redirect"), { allowLocal: true })).response).toMatchObject({
      redirects: 1,
      statusCode: 200,
      url: `${origin}/health`,
    });
    expect(
      (await executeSyntheticRequest(request("/redirect", { followRedirects: false }), { allowLocal: true })).response.statusCode,
    ).toBe(302);
    await expect(executeSyntheticRequest(request("/loop"), { allowLocal: true })).rejects.toThrow("Redirected more than 5 times");
  });

  it("drops credentials on a redirect to another origin", async () => {
    const other = origin.replace("127.0.0.1", "localhost");
    await executeSyntheticRequest(
      request(`/elsewhere?to=${encodeURIComponent(`${other}/health`)}`, {
        headers: [
          { name: "Authorization", secret: false, value: "Bearer a" },
          { name: "X-Key", secret: true, value: "b" },
          { name: "X-Trace", secret: false, value: "c" },
        ],
      }),
      { allowLocal: true, resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
    );
    const last = seen.at(-1)!;
    expect(last.headers.authorization).toBeUndefined();
    expect(last.headers["x-key"]).toBeUndefined();
    expect(last.headers["x-trace"]).toBe("c");
  });

  it("refuses private and loopback hosts outside local development", async () => {
    await expect(executeSyntheticRequest(request("/health"))).rejects.toThrow("The URL must use a public host");
    await expect(
      executeSyntheticRequest(request("/health", { url: "http://internal.example.com/" }), {
        resolve: async () => [{ address: "10.0.0.8", family: 4 }],
      }),
    ).rejects.toThrow("The host must resolve only to public addresses");
    await expect(
      executeSyntheticRequest(request("/health", { url: "http://metadata.example.com/" }), {
        resolve: async () => [{ address: "93.184.215.14", family: 4 }, { address: "169.254.169.254", family: 4 }],
      }),
    ).rejects.toThrow("The host must resolve only to public addresses");
  });

  it("reports a timeout with the time spent", async () => {
    const result = await runSyntheticAttempt(request("/slow", { timeoutMs: 1_000 }), [], { allowLocal: true });
    expect(result).toMatchObject({ error: "Timed out after 1000 ms", response: null, status: "failed" });
    expect(result.durationMs).toBeGreaterThanOrEqual(990);
  });

  it("retries a failed run and keeps the last attempt", async () => {
    const before = seen.length;
    const result = await runSyntheticCheck(
      {
        assertions: [{ kind: "status_code", op: "eq", severity: "critical", value: "2xx" }],
        request: request("/down"),
        retries: 2,
      },
      { allowLocal: true, retryDelayMs: 0 },
    );
    expect(result).toMatchObject({ attempts: 3, status: "failed" });
    expect(result.response?.statusCode).toBe(503);
    expect(seen.length - before).toBe(3);

    const passing = await runSyntheticCheck({ assertions: [], request: request("/health"), retries: 2 }, { allowLocal: true });
    expect(passing).toMatchObject({ attempts: 1, status: "passed" });
  });
});
