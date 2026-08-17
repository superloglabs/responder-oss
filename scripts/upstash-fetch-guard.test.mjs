/* global AbortSignal, ReadableStream, Response */

import { describe, expect, it, vi } from "vitest";
import { createBoundedUpstashFetch } from "../apps/worker/src/upstash-fetch-guard.mjs";

describe("Upstash child fetch guard", () => {
  it("answers the upstream write probe locally to select read-only tokens", async () => {
    const fetchImplementation = vi.fn();
    const guardedFetch = createBoundedUpstashFetch(fetchImplementation, 1_000);

    const response = await guardedFetch(
      "https://api.upstash.com/v2/redis/database/readonly-check-nonexistent",
      { method: "DELETE" },
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("Readonly API key");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("blocks unexpected origins and management mutations", async () => {
    const fetchImplementation = vi.fn();
    const guardedFetch = createBoundedUpstashFetch(fetchImplementation, 1_000);

    await expect(guardedFetch("https://example.com/data")).rejects.toThrow(
      "unexpected request origin",
    );
    await expect(
      guardedFetch("https://api.upstash.com/v2/redis/database/db-1", {
        method: "POST",
      }),
    ).rejects.toThrow("management API mutation");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("allows fixed Upstash reads and Redis command posts", async () => {
    const fetchImplementation = vi
      .fn()
      .mockImplementation(async () => Response.json({ result: "ok" }));
    const guardedFetch = createBoundedUpstashFetch(fetchImplementation, 1_000);

    await expect(
      guardedFetch("https://api.upstash.com/v2/redis/databases"),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      guardedFetch("https://example-db.upstash.io", { method: "POST" }),
    ).resolves.toBeInstanceOf(Response);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      "https://example-db.upstash.io",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("aborts a streaming response before unbounded parsing", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(600));
          controller.enqueue(new Uint8Array(600));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const guardedFetch = createBoundedUpstashFetch(
      vi.fn().mockResolvedValue(response),
      1_000,
    );

    const guardedResponse = await guardedFetch(
      "https://example-db.upstash.io",
      { method: "POST" },
    );
    await expect(guardedResponse.arrayBuffer()).rejects.toThrow(
      "exceeded the 1 MiB investigation limit",
    );
    expect(cancelled).toBe(true);
  });

  it("rejects an excessive declared content length before reading", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-length": "1001" } },
    );
    const guardedFetch = createBoundedUpstashFetch(
      vi.fn().mockResolvedValue(response),
      1_000,
    );

    await expect(
      guardedFetch("https://api.upstash.com/v2/redis/databases"),
    ).rejects.toThrow("exceeded the 1 MiB investigation limit");
    expect(cancelled).toBe(true);
  });

  it("aborts stalled child requests with a stable error", async () => {
    const fetchImplementation = vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        }),
    );
    const guardedFetch = createBoundedUpstashFetch(
      fetchImplementation,
      1_000,
      5,
    );

    await expect(
      guardedFetch("https://api.upstash.com/v2/redis/databases"),
    ).rejects.toThrow("exceeded the investigation timeout");
  });

  it("maps a stalled response body timeout to the same stable error", async () => {
    const fetchImplementation = vi.fn((_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal.addEventListener(
                "abort",
                () => controller.error(init.signal.reason),
                { once: true },
              );
            },
          }),
        ),
      ),
    );
    const guardedFetch = createBoundedUpstashFetch(
      fetchImplementation,
      1_000,
      5,
    );

    const response = await guardedFetch(
      "https://api.upstash.com/v2/redis/databases",
    );
    await expect(response.text()).rejects.toThrow(
      "exceeded the investigation timeout",
    );
  });
});
