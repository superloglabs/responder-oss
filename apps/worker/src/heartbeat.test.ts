import { describe, expect, it, vi } from "vitest";
import { sendWorkerHeartbeat, workerHeartbeatUrl } from "./heartbeat.js";

const now = new Date("2026-10-28T09:00:00.000Z");

describe("worker heartbeat", () => {
  it("pings the check after the database answers", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async () => {
      calls.push("ping");
      return new Response("OK");
    });
    await expect(
      sendWorkerHeartbeat({
        checkDatabase: async () => {
          calls.push("database");
        },
        fetch,
        now,
        requestedAt: "2026-10-28T08:59:30.000Z",
        url: "https://hc-ping.com/check",
      }),
    ).resolves.toBe("sent");
    expect(calls).toEqual(["database", "ping"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://hc-ping.com/check",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not ping when the database check fails", async () => {
    const fetch = vi.fn();
    await expect(
      sendWorkerHeartbeat({
        checkDatabase: async () => {
          throw new Error("Query read timeout");
        },
        fetch,
        now,
        requestedAt: now.toISOString(),
        url: "https://hc-ping.com/check",
      }),
    ).rejects.toThrow("Query read timeout");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips jobs queued more than two intervals ago", async () => {
    const checkDatabase = vi.fn();
    await expect(
      sendWorkerHeartbeat({
        checkDatabase,
        now,
        requestedAt: "2026-10-28T08:57:00.000Z",
        url: "https://hc-ping.com/check",
      }),
    ).resolves.toBe("skipped");
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("skips when no check is configured", async () => {
    await expect(
      sendWorkerHeartbeat({ checkDatabase: vi.fn(), requestedAt: now.toISOString(), url: undefined }),
    ).resolves.toBe("skipped");
  });

  it("reports a ping the check rejects", async () => {
    await expect(
      sendWorkerHeartbeat({
        checkDatabase: async () => undefined,
        fetch: async () => new Response("not found", { status: 404 }),
        now,
        requestedAt: now.toISOString(),
        url: "https://hc-ping.com/check",
      }),
    ).rejects.toThrow("Worker heartbeat ping returned 404");
  });

  it("accepts only an HTTPS check URL", () => {
    expect(workerHeartbeatUrl({})).toBeUndefined();
    expect(workerHeartbeatUrl({ WORKER_HEARTBEAT_URL: " https://hc-ping.com/check " })).toBe(
      "https://hc-ping.com/check",
    );
    expect(() => workerHeartbeatUrl({ WORKER_HEARTBEAT_URL: "http://hc-ping.com/check" })).toThrow(
      "WORKER_HEARTBEAT_URL must be an HTTPS URL",
    );
  });
});
