import { describe, expect, it, vi } from "vitest";
import { createConcurrencyLimiter, limitedTelemetryClient, WorkspaceBusyError, workspaceQueryConcurrency } from "./workspace-limits.js";
import type { TelemetryClient } from "../../../packages/core/src/telemetry/client.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("createConcurrencyLimiter", () => {
  it("runs at most the limit per workspace and lets other workspaces through", async () => {
    const limiter = createConcurrencyLimiter({ limit: 2, maxWaiting: 10, waitMs: 1_000 });
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
    };
    const busy = [limiter.run("a", task), limiter.run("a", task), limiter.run("a", task)];
    let otherRan = false;
    await limiter.run("b", async () => { otherRan = true; });

    expect(otherRan).toBe(true);
    expect(peak).toBe(2);
    gate.resolve();
    await Promise.all(busy);
    expect(peak).toBe(2);
  });

  it("refuses a task that waits too long or finds the queue full", async () => {
    vi.useFakeTimers();
    try {
      const limiter = createConcurrencyLimiter({ limit: 1, maxWaiting: 1, waitMs: 500 });
      const gate = deferred();
      const first = limiter.run("a", () => gate.promise);
      const waiting = limiter.run("a", async () => "late");
      await expect(limiter.run("a", async () => "full")).rejects.toBeInstanceOf(WorkspaceBusyError);
      vi.advanceTimersByTime(501);
      await expect(waiting).rejects.toBeInstanceOf(WorkspaceBusyError);
      gate.resolve();
      await first;
      expect(await limiter.run("a", async () => "free")).toBe("free");
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a slot without waiting, or reports that none is free", () => {
    const limiter = createConcurrencyLimiter({ limit: 1, maxWaiting: 0, waitMs: 0 });
    const release = limiter.tryAcquire("a");
    expect(release).toBeTypeOf("function");
    expect(limiter.tryAcquire("a")).toBeNull();
    expect(limiter.tryAcquire("b")).toBeTypeOf("function");
    release!();
    expect(limiter.tryAcquire("a")).toBeTypeOf("function");
  });

  it("answers 429 with a retry hint", async () => {
    const response = new WorkspaceBusyError(3).getResponse();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toMatchObject({ code: "workspace_busy" });
  });
});

describe("limitedTelemetryClient", () => {
  it("queues a workspace's queries and passes other calls through", async () => {
    const client = {
      close: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ json: async () => [{ rows: 1 }] })),
    };
    const limiter = createConcurrencyLimiter({ limit: 1, maxWaiting: 10, waitMs: 1_000 });
    const limited = limitedTelemetryClient(client as unknown as TelemetryClient, "org", limiter);

    const first = await limited.query({ query: "select 1" });
    const second = limited.query({ query: "select 2" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The first result has not been read, so its connection is still in use.
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(await first.json()).toEqual([{ rows: 1 }]);
    await second;
    expect(client.query).toHaveBeenCalledTimes(2);
    await limited.close();
    expect(client.close).toHaveBeenCalled();
  });
});

describe("workspaceQueryConcurrency", () => {
  it("gives a workspace half of the store connections", () => {
    expect(workspaceQueryConcurrency({})).toBe(5);
    expect(workspaceQueryConcurrency({ TELEMETRY_CLICKHOUSE_MAX_CONNECTIONS: "2" })).toBe(1);
    expect(workspaceQueryConcurrency({ TELEMETRY_CLICKHOUSE_MAX_CONNECTIONS: "8" })).toBe(4);
    expect(workspaceQueryConcurrency({ TELEMETRY_WORKSPACE_QUERY_CONCURRENCY: "3" })).toBe(3);
    expect(workspaceQueryConcurrency({ TELEMETRY_CLICKHOUSE_MAX_CONNECTIONS: "1e2" })).toBe(50);
  });
});
