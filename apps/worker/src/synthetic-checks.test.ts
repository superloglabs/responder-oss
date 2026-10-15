import { describe, expect, it, vi } from "vitest";
import type { DueSyntheticCheck, OpenSyntheticCheckEpisode } from "@responder/core/db/synthetic-checks";
import type { SyntheticRunResult } from "@responder/core/synthetics/types";
import {
  createSyntheticCheckScheduler,
  processSyntheticCheck,
  purgeSyntheticCheckRuns,
  syntheticLocation,
  type SyntheticCheckDependencies,
} from "./synthetic-checks.js";

const now = new Date("2026-10-15T12:00:00.000Z");
const slack = { channelId: "C123", integrationAccountId: "00000000-0000-4000-8000-0000000000aa" };
const request = { body: null, followRedirects: true, headers: [], method: "GET" as const, timeoutMs: 10_000, url: "https://shop.example.com/health" };

const check: DueSyntheticCheck = {
  ...request,
  assertions: [{ kind: "status_code", op: "eq", severity: "critical", value: "2xx" }],
  consecutiveFailures: 0,
  createdAt: now.toISOString(),
  enabled: true,
  failuresToAlert: 2,
  id: "check-1",
  intervalSeconds: 60,
  lastRunAt: null,
  lastStatus: null,
  name: "Shop health",
  organizationId: "org-1",
  request,
  retries: 1,
  sendMetrics: true,
  slack,
  statusSince: null,
  updatedAt: now.toISOString(),
};

function result(status: SyntheticRunResult["status"]): SyntheticRunResult {
  const statusCode = status === "failed" ? 503 : 200;
  return {
    assertions: [{ actual: String(statusCode), assertion: check.assertions[0]!, passed: status !== "failed" }],
    attempts: status === "failed" ? 2 : 1,
    durationMs: 120,
    error: null,
    response: { body: "", bodyBytes: 0, bodyTruncated: false, certificateExpiresAt: null, headers: {}, redirects: 0, statusCode, url: request.url },
    startedAt: now.toISOString(),
    status,
    timings: { connectMs: 10, dnsMs: 5, downloadMs: 5, firstByteMs: 90, tlsMs: 10 },
  };
}

function episode(overrides: Partial<OpenSyntheticCheckEpisode> = {}): OpenSyntheticCheckEpisode {
  return {
    failedRuns: 2,
    id: "episode-1",
    slackChannelId: slack.channelId,
    slackIntegrationAccountId: slack.integrationAccountId,
    slackMessageTs: "1700000000.000100",
    startedAt: new Date(now.getTime() - 30 * 60_000),
    ...overrides,
  };
}

function dependencies(overrides: Partial<SyntheticCheckDependencies> = {}) {
  const dependencies: SyntheticCheckDependencies = {
    claim: vi.fn(async () => [check]),
    continueEpisode: vi.fn(async () => undefined),
    exportMetrics: vi.fn(async () => undefined),
    location: "eu-west-3",
    markRecoveryNotified: vi.fn(async () => undefined),
    now: () => now,
    openEpisode: vi.fn(async () => null),
    origin: "https://superlog.sh",
    post: vi.fn<SyntheticCheckDependencies["post"]>(async (input) =>
      input.notifications.map((notification) => ({ notification, timestamp: "1700000000.000200" })),
    ),
    recordRun: vi.fn(async () => 1),
    resolveEpisode: vi.fn(async () => true),
    run: vi.fn(async () => result("passed")),
    setMessage: vi.fn(async () => undefined),
    startAutomations: vi.fn(async () => 1),
    startEpisode: vi.fn(async () => episode({ slackMessageTs: null })),
    unannouncedRecoveries: vi.fn(async () => []),
    ...overrides,
  };
  return dependencies;
}

describe("processSyntheticCheck", () => {
  it("records a passing run and sends its metrics", async () => {
    const deps = dependencies();

    await processSyntheticCheck(check, deps);

    expect(deps.recordRun).toHaveBeenCalledWith(check, result("passed"), "eu-west-3");
    expect(deps.exportMetrics).toHaveBeenCalledWith("org-1", expect.objectContaining({ resourceMetrics: expect.any(Array) }));
    expect(deps.startEpisode).not.toHaveBeenCalled();
    expect(deps.post).not.toHaveBeenCalled();
  });

  it("waits for the failures in a row the check asks for", async () => {
    const deps = dependencies({ recordRun: vi.fn(async () => 1), run: vi.fn(async () => result("failed")) });

    await processSyntheticCheck(check, deps);

    expect(deps.startEpisode).not.toHaveBeenCalled();
  });

  it("opens an episode, posts it and starts the channel's automations", async () => {
    const deps = dependencies({ recordRun: vi.fn(async () => 2), run: vi.fn(async () => result("failed")) });

    await processSyntheticCheck(check, deps);

    expect(deps.startEpisode).toHaveBeenCalledWith({
      checkId: "check-1",
      checkUpdatedAt: check.updatedAt,
      failedRuns: 2,
      reason: "Expected status code is 2xx, got 503",
      slack,
    });
    expect(deps.post).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: expect.stringContaining("The last 2 runs failed from eu-west-3"),
        seed: "synthetic-check-episode:episode-1:failing",
        text: "Shop health is failing",
      }),
    );
    expect(deps.setMessage).toHaveBeenCalledWith("episode-1", "1700000000.000200");
    expect(deps.startAutomations).toHaveBeenCalledWith(
      expect.objectContaining({ episodeId: "episode-1", episodeSource: "synthetic-check-episode", timestamp: "1700000000.000200" }),
    );
  });

  it("counts further failures and retries a failed announcement", async () => {
    const deps = dependencies({
      openEpisode: vi.fn(async () => episode({ slackMessageTs: null })),
      recordRun: vi.fn(async () => 3),
      run: vi.fn(async () => result("failed")),
    });

    await processSyntheticCheck(check, deps);

    expect(deps.continueEpisode).toHaveBeenCalledWith("episode-1");
    expect(deps.startEpisode).not.toHaveBeenCalled();
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({ markdown: expect.stringContaining("The last 3 runs failed") }));
  });

  it("ends the episode and replies in its thread when a run passes", async () => {
    const deps = dependencies({ openEpisode: vi.fn(async () => episode()) });

    await processSyntheticCheck(check, deps);

    expect(deps.resolveEpisode).toHaveBeenCalledWith("episode-1");
    expect(deps.post).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: expect.stringContaining("recovered after 30 minutes. It answered 200 in 120 ms."),
        seed: "synthetic-check-episode:episode-1:recovered",
        threadTimestamp: "1700000000.000100",
      }),
    );
    expect(deps.markRecoveryNotified).toHaveBeenCalledWith("episode-1");
  });

  it("does not count a run of a check that changed while it ran", async () => {
    const deps = dependencies({ recordRun: vi.fn(async () => null), run: vi.fn(async () => result("failed")) });

    await processSyntheticCheck(check, deps);

    expect(deps.openEpisode).not.toHaveBeenCalled();
    expect(deps.startEpisode).not.toHaveBeenCalled();
  });

  it("keeps going when the metrics cannot be sent", async () => {
    const deps = dependencies({
      exportMetrics: vi.fn(async () => {
        throw new Error("collector down");
      }),
      recordRun: vi.fn(async () => 2),
      run: vi.fn(async () => result("failed")),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await processSyntheticCheck(check, deps);

    expect(deps.startEpisode).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("createSyntheticCheckScheduler", () => {
  it("claims only into free slots while checks run", async () => {
    let finish!: () => void;
    const blocked = new Promise<SyntheticRunResult>((resolve) => {
      finish = () => resolve(result("passed"));
    });
    const deps = dependencies({ claim: vi.fn(async (limit: number) => Array.from({ length: limit }, () => check)), run: vi.fn(() => blocked) });
    const scheduler = createSyntheticCheckScheduler(deps, { concurrency: 3 });

    expect(await scheduler.tick()).toBe(3);
    expect(await scheduler.tick()).toBe(0);
    expect(deps.claim).toHaveBeenLastCalledWith(0);
    finish();
    await scheduler.stop();
    expect(deps.recordRun).toHaveBeenCalledTimes(3);
    expect(await scheduler.tick()).toBe(0);
  });
});

describe("createSyntheticCheckScheduler refill", () => {
  it("claims the next due check as soon as one finishes", async () => {
    const claim = vi.fn<SyntheticCheckDependencies["claim"]>().mockResolvedValueOnce([check]).mockResolvedValueOnce([check]).mockResolvedValue([]);
    const deps = dependencies({ claim });
    const scheduler = createSyntheticCheckScheduler(deps, { concurrency: 1 });

    await scheduler.tick();
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(3));
    expect(deps.recordRun).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});

describe("purgeSyntheticCheckRuns", () => {
  it("deletes runs older than 30 days in batches", async () => {
    const deleteBefore = vi.fn().mockResolvedValueOnce(5_000).mockResolvedValueOnce(12);

    expect(await purgeSyntheticCheckRuns(now, deleteBefore)).toBe(5_012);
    expect(deleteBefore).toHaveBeenCalledWith(new Date("2026-09-15T12:00:00.000Z"), 5_000);
    expect(deleteBefore).toHaveBeenCalledTimes(2);
  });
});

describe("syntheticLocation", () => {
  it("prefers the configured location, then the region", () => {
    expect(syntheticLocation({ AWS_REGION: "us-east-1", SYNTHETICS_LOCATION: "Paris" })).toBe("Paris");
    expect(syntheticLocation({ AWS_REGION: "us-east-1" })).toBe("us-east-1");
    expect(syntheticLocation({})).toBe("local");
  });
});
