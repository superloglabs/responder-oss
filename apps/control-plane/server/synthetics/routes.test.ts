import { describe, expect, it, vi } from "vitest";
import type { SyntheticCheck } from "../../../../packages/core/src/db/synthetic-checks.js";
import { createSyntheticRoutes, type SyntheticRouteDependencies } from "./routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const checkId = "11111111-1111-4111-8111-111111111111";
const runId = "33333333-3333-4333-8333-333333333333";
const accountId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-15T12:00:00.000Z");

const check: SyntheticCheck = {
  assertions: [],
  body: null,
  consecutiveFailures: 0,
  createdAt: now.toISOString(),
  enabled: true,
  failuresToAlert: 1,
  followRedirects: true,
  headers: [{ name: "Authorization", secret: true, value: "" }],
  id: checkId,
  intervalSeconds: 300,
  lastRunAt: null,
  lastStatus: null,
  method: "GET",
  name: "Health",
  retries: 1,
  slack: null,
  statusSince: null,
  timeoutMs: 10_000,
  updatedAt: now.toISOString(),
  url: "https://api.example.com/health",
};

const testResult = {
  assertions: [],
  durationMs: 50,
  error: null,
  response: null,
  startedAt: now.toISOString(),
  status: "passed" as const,
  timings: { connectMs: 0, dnsMs: 0, downloadMs: 0, firstByteMs: 0, tlsMs: 0 },
};

function routes(overrides: Partial<SyntheticRouteDependencies> = {}) {
  const dependencies: SyntheticRouteDependencies = {
    createCheck: vi.fn(async () => ({ check })),
    deleteCheck: vi.fn(async () => true),
    episodes: vi.fn(async () => []),
    findCheck: vi.fn(async () => check),
    findRun: vi.fn(async () => null),
    hasCapability: vi.fn(async () => true),
    listChecks: vi.fn(async () => [{ ...check, averageDurationMs: null, recent: [], uptime: null }]),
    now: () => now,
    refreshSlackChannels: vi.fn(async () => undefined),
    runs: vi.fn(async () => []),
    secrets: vi.fn(async () => ({ secrets: { authorization: "Bearer saved" }, url: check.url })),
    slackChannels: vi.fn(async () => [
      { accountName: "Acme", channelId: "C1", integrationAccountId: accountId, name: "alerts", private: false },
    ]),
    stats: vi.fn(async () => ({ averageDurationMs: null, buckets: [], p95DurationMs: null, runs: 0, uptime: null })),
    tenant: vi.fn(async () => ({ ok: true as const, organizationId, user: { id: userId } })),
    test: vi.fn(async () => testResult),
    updateCheck: vi.fn(async () => ({ check })),
    ...overrides,
  };
  return { app: createSyntheticRoutes(dependencies), dependencies };
}

function send(app: ReturnType<typeof routes>["app"], method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

describe("synthetic check routes", () => {
  it("are not found without the alerts capability", async () => {
    const { app } = routes({ hasCapability: vi.fn(async () => false) });

    expect((await app.request("/")).status).toBe(404);
    expect((await send(app, "POST", "/test", { url: "https://example.com" })).status).toBe(404);
  });

  it("lists checks and reads one with its runs for a range", async () => {
    const { app, dependencies } = routes();

    expect((await (await app.request("/")).json()).checks).toHaveLength(1);
    const detail = await (await app.request(`/${checkId}?range=7d`)).json();
    expect(detail).toMatchObject({ bucketSeconds: 7_200, check, since: "2026-10-08T12:00:00.000Z" });
    expect(dependencies.stats).toHaveBeenCalledWith(checkId, new Date("2026-10-08T12:00:00.000Z"), 7_200);
    expect(dependencies.runs).toHaveBeenCalledWith(checkId, { limit: 50 });
  });

  it("creates a check for the member, checking its Slack channel", async () => {
    const { app, dependencies } = routes();
    const body = { name: "Health", url: "https://api.example.com/health" };

    expect((await send(app, "POST", "/", body)).status).toBe(201);
    expect(dependencies.createCheck).toHaveBeenCalledWith(organizationId, expect.objectContaining({ ...body, createdBy: userId }));

    const response = await send(app, "POST", "/", { ...body, slack: { channelId: "C9", integrationAccountId: accountId } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose a Slack channel from a connected workspace" });
  });

  it("rejects an invalid check with the first problem", async () => {
    const { app } = routes();
    const response = await send(app, "POST", "/", { name: "Health", url: "ftp://example.com" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The URL must use HTTP or HTTPS" });
  });

  it("tests a request with the saved secret of the check's origin", async () => {
    const { app, dependencies } = routes();

    const response = await send(app, "POST", "/test", {
      checkId,
      headers: [{ name: "Authorization", secret: true, value: null }],
      url: `${check.url}?probe=1`,
    });

    expect(response.status).toBe(200);
    expect(dependencies.test).toHaveBeenCalledWith(
      expect.objectContaining({ headers: [{ name: "Authorization", secret: true, value: "Bearer saved" }] }),
      [],
      { previewBytes: 65_536 },
    );

    const moved = await send(app, "POST", "/test", {
      checkId,
      headers: [{ name: "Authorization", secret: true, value: null }],
      url: "https://elsewhere.example.net/",
    });
    expect(moved.status).toBe(400);
  });

  it("limits test requests per workspace", async () => {
    const { app } = routes();
    for (let index = 0; index < 20; index += 1) {
      expect((await send(app, "POST", "/test", { url: "https://example.com" })).status).toBe(200);
    }
    expect((await send(app, "POST", "/test", { url: "https://example.com" })).status).toBe(429);
  });

  it("does not read runs of another workspace's check", async () => {
    const { app, dependencies } = routes({ findCheck: vi.fn(async () => null) });

    expect((await app.request(`/${checkId}/runs/${runId}`)).status).toBe(404);
    expect(dependencies.findRun).not.toHaveBeenCalled();
  });

  it("pages runs before a run", async () => {
    const { app, dependencies } = routes();
    const before = "2026-10-15T11:00:00.000Z";

    expect((await app.request(`/${checkId}/runs?before=${before}&beforeId=${runId}`)).status).toBe(200);
    expect(dependencies.runs).toHaveBeenCalledWith(checkId, { before: { id: runId, startedAt: before }, limit: 50 });
    expect((await app.request(`/${checkId}/runs?before=yesterday`)).status).toBe(400);
  });

  it("keeps a saved Slack channel that is no longer listed", async () => {
    const saved = { ...check, slack: { channelId: "C-gone", integrationAccountId: accountId } };
    const { app } = routes({ findCheck: vi.fn(async () => saved) });
    const body = { name: "Health", url: check.url };

    expect((await send(app, "PUT", `/${checkId}`, { ...body, slack: saved.slack })).status).toBe(200);
    expect((await send(app, "PUT", `/${checkId}`, { ...body, slack: { channelId: "C-other", integrationAccountId: accountId } })).status).toBe(400);
  });

  it("updates and deletes checks", async () => {
    const { app, dependencies } = routes({ deleteCheck: vi.fn(async () => false) });

    expect((await send(app, "PUT", `/${checkId}`, { name: "Health", url: check.url })).status).toBe(200);
    expect(dependencies.updateCheck).toHaveBeenCalledWith(organizationId, checkId, expect.objectContaining({ name: "Health" }));
    expect((await send(app, "DELETE", `/${checkId}`)).status).toBe(404);
  });
});
