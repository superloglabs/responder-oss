import type { LogWatch } from "@responder/core/db/log-watches";
import { TelemetryReadError } from "@responder/core/telemetry/reads";
import { describe, expect, it, vi } from "vitest";
import { checkDueLogWatches, checkLogWatch, type LogWatchDependencies } from "./log-watches.js";

const now = new Date("2026-11-08T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function watch(overrides: Partial<LogWatch> = {}): LogWatch {
  return {
    checkedThrough: minutesAgo(1),
    createdAt: minutesAgo(10),
    createdBy: "21212121-2121-4121-8121-212121212121",
    endReason: null,
    endedAt: null,
    expiresAt: new Date(now.getTime() + 50 * 60_000),
    filters: { service: "checkout", severity: "ERROR" },
    id: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
    nextCheckAt: now,
    organizationId: "15151515-1515-4515-8515-151515151515",
    subscribersCheckedAt: minutesAgo(1),
    ...overrides,
  };
}

function log(body: string) {
  return {
    attributes: {}, body, eventName: "", exception: null, resourceAttributes: {}, service: "checkout",
    severity: "ERROR", severityNumber: 17, spanId: "", timestamp: now.toISOString(), traceId: "",
  };
}

function dependencies(logs: ReturnType<typeof log>[] = [], overrides: Partial<LogWatchDependencies> = {}) {
  const deps: LogWatchDependencies = {
    advance: vi.fn(async () => undefined),
    claim: vi.fn(async () => [watch()]),
    client: () => ({}) as never,
    enabled: () => true,
    end: vi.fn(async () => undefined),
    notify: vi.fn(async () => ({ matched: 1 })),
    now: () => now,
    search: vi.fn(async () => ({ logs, since: "", until: "" })),
    subscribers: vi.fn(async () => 1),
    ...overrides,
  };
  return deps;
}

describe("checkLogWatch", () => {
  it("reads the new matching logs up to 30 seconds ago and wakes the conversation with one batch", async () => {
    const deps = dependencies([log("payment failed"), log("card declined")]);

    await checkLogWatch(watch(), {} as never, deps);

    const until = new Date(now.getTime() - 30_000);
    expect(deps.search).toHaveBeenCalledWith(expect.anything(), "15151515-1515-4515-8515-151515151515", {
      limit: 21, range: "15m", service: "checkout", severity: "ERROR",
      since: minutesAgo(1).toISOString(), until: until.toISOString(),
    }, now);
    expect(deps.notify).toHaveBeenCalledWith({
      count: 2,
      latest: { body: "payment failed", service: "checkout", severity: "ERROR" },
      more: false,
      since: minutesAgo(1),
      until,
      watchId: watch().id,
    });
    expect(deps.advance).toHaveBeenCalledWith({ checkedThrough: until, id: watch().id, subscribersCheckedAt: now });
  });

  it("says there are more when a batch is full", async () => {
    const deps = dependencies(Array.from({ length: 21 }, (_, index) => log(`line ${index}`)));

    await checkLogWatch(watch(), {} as never, deps);

    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ count: 20, more: true }));
  });

  it("reads at most ten minutes after falling behind", async () => {
    const deps = dependencies();

    await checkLogWatch(watch({ checkedThrough: minutesAgo(90) }), {} as never, deps);

    const until = now.getTime() - 30_000;
    expect(deps.search).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      since: new Date(until - 10 * 60_000).toISOString(),
    }), now);
  });

  it("moves on without waking anyone when nothing matched", async () => {
    const deps = dependencies();

    await checkLogWatch(watch(), {} as never, deps);

    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.subscribers).not.toHaveBeenCalled();
    expect(deps.advance).toHaveBeenCalledWith({ checkedThrough: new Date(now.getTime() - 30_000), id: watch().id });
  });

  it("ends a quiet watch nobody listens to any more", async () => {
    const deps = dependencies([], { subscribers: vi.fn(async () => 0) });

    await checkLogWatch(watch({ subscribersCheckedAt: minutesAgo(6) }), {} as never, deps);

    expect(deps.end).toHaveBeenCalledWith(watch().id, "unsubscribed", now);
    expect(deps.advance).not.toHaveBeenCalled();
  });

  it("ends a watch whose batch reached nobody", async () => {
    const deps = dependencies([log("payment failed")], { notify: vi.fn(async () => ({ matched: 0 })) });

    await checkLogWatch(watch(), {} as never, deps);

    expect(deps.end).toHaveBeenCalledWith(watch().id, "unsubscribed", now);
  });

  it("keeps a new watch whose conversation may not be subscribed yet", async () => {
    const deps = dependencies([log("payment failed")], { notify: vi.fn(async () => ({ matched: 0 })) });

    await checkLogWatch(watch({ createdAt: minutesAgo(1) }), {} as never, deps);

    expect(deps.end).not.toHaveBeenCalled();
    expect(deps.advance).toHaveBeenCalled();
  });

  it("reads the same logs again after a failed emit or query", async () => {
    const failedEmit = dependencies([log("payment failed")], { notify: vi.fn(async () => null) });
    await checkLogWatch(watch(), {} as never, failedEmit);
    expect(failedEmit.advance).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timedOut = dependencies([], {
      search: vi.fn(async () => {
        throw new TelemetryReadError("The query did not finish in time.", "telemetry_query_timeout");
      }),
    });
    await checkLogWatch(watch(), {} as never, timedOut);
    expect(timedOut.advance).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("log_watch_query_failed"));
    warn.mockRestore();
  });
});

describe("checkDueLogWatches", () => {
  it("does nothing without Wakeshift or a telemetry store", async () => {
    const off = dependencies([], { enabled: () => false });
    const noStore = dependencies([], { client: () => null });

    expect(await checkDueLogWatches(off)).toBe(0);
    expect(await checkDueLogWatches(noStore)).toBe(0);
    expect(off.claim).not.toHaveBeenCalled();
    expect(noStore.claim).not.toHaveBeenCalled();
  });

  it("checks every claimed watch, and a failing one does not stop the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = dependencies([], {
      advance: vi.fn().mockRejectedValueOnce(new Error("connection reset")).mockResolvedValue(undefined),
      claim: vi.fn(async () => [watch({ id: "one" }), watch({ id: "two" }), watch({ id: "three" })]),
    });

    expect(await checkDueLogWatches(deps)).toBe(3);
    expect(deps.claim).toHaveBeenCalledWith(10, now);
    expect(deps.advance).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("log_watch_check_failed"));
    warn.mockRestore();
  });
});
