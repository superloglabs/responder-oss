import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pullRequestRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const pullRequestId = "31313131-3131-4131-8131-313131313131";

const mocks = vi.hoisted(() => ({
  capability: vi.fn().mockResolvedValue(true),
  detail: vi.fn(),
  get: vi.fn(),
  installations: vi.fn(),
  list: vi.fn(),
  states: vi.fn(),
  tenant: vi.fn(),
}));

vi.mock("../tenant.js", () => ({ getActiveTenant: mocks.tenant }));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationHasCapability: mocks.capability,
}));
vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  getAutomationPullRequest: mocks.get,
  getGitHubRepositoryInstallations: mocks.installations,
  listAutomationPullRequests: mocks.list,
}));
vi.mock("./github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github.js")>()),
  fetchPullRequestDetail: mocks.detail,
  fetchPullRequestStates: mocks.states,
}));

const app = new Hono().route("/api/pull-requests", pullRequestRoutes);

function record(overrides: Record<string, unknown> = {}) {
  return {
    automationId: "a1",
    automationName: "Fix errors",
    createdAt: "2026-10-01T00:00:00.000Z",
    id: pullRequestId,
    repository: "acme/api",
    runId: "r1",
    title: "Fix login",
    url: "https://github.com/acme/api/pull/42",
    ...overrides,
  };
}

describe("pull request routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.capability.mockResolvedValue(true);
  });

  mocks.tenant.mockResolvedValue({ ok: true, organizationId, user: { id: "u1", name: "Ash" } });

  it("returns not found without the automations capability", async () => {
    mocks.capability.mockResolvedValue(false);

    const response = await app.request("/api/pull-requests");

    expect(response.status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lists the organization's pull requests with their GitHub states", async () => {
    mocks.list.mockResolvedValue({
      pullRequests: [
        record(),
        record({ id: "p2", url: "https://github.com/acme/web/pull/7" }),
        record({ id: "p3", url: "https://github.com/other/repo/pull/1" }),
      ],
      total: 3,
    });
    mocks.installations.mockResolvedValue(new Map([["acme/api", 11], ["acme/web", 11]]));
    mocks.states.mockResolvedValue(["merged", "open"]);

    const response = await app.request("/api/pull-requests?page=2");
    const body = await response.json() as { pullRequests: Array<{ number: number; state: string | null }>; total: number };

    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(organizationId, { limit: 25, offset: 25 });
    expect(mocks.installations).toHaveBeenCalledWith(organizationId, ["acme/api", "acme/web", "other/repo"]);
    expect(mocks.states).toHaveBeenCalledTimes(1);
    expect(body.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.state])).toEqual([[42, "merged"], [7, "open"], [1, null]]);
  });

  it("still lists pull requests when GitHub fails", async () => {
    mocks.list.mockResolvedValue({ pullRequests: [record()], total: 1 });
    mocks.installations.mockResolvedValue(new Map([["acme/api", 11]]));
    mocks.states.mockRejectedValue(new Error("GitHub returned 502"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await app.request("/api/pull-requests");
    const body = await response.json() as { pullRequests: Array<{ state: string | null }> };

    expect(response.status).toBe(200);
    expect(body.pullRequests[0]?.state).toBeNull();
  });

  it("scopes the detail to the organization and reads it from GitHub", async () => {
    mocks.get.mockResolvedValue(record());
    mocks.installations.mockResolvedValue(new Map([["acme/api", 11]]));
    mocks.detail.mockResolvedValue({ title: "Fix login" });

    const response = await app.request(`/api/pull-requests/${pullRequestId}`);
    const body = await response.json() as { github: unknown; githubError: string | null };

    expect(mocks.get).toHaveBeenCalledWith(organizationId, pullRequestId);
    expect(mocks.detail).toHaveBeenCalledWith(11, { number: 42, owner: "acme", repo: "api" });
    expect(body).toMatchObject({ github: { title: "Fix login" }, githubError: null });
  });

  it("returns not found for another organization's pull request", async () => {
    mocks.get.mockResolvedValue(null);

    const response = await app.request(`/api/pull-requests/${pullRequestId}`);

    expect(response.status).toBe(404);
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("explains when the repository is no longer connected", async () => {
    mocks.get.mockResolvedValue(record());
    mocks.installations.mockResolvedValue(new Map());

    const response = await app.request(`/api/pull-requests/${pullRequestId}`);
    const body = await response.json() as { github: unknown; githubError: string };

    expect(response.status).toBe(200);
    expect(body.github).toBeNull();
    expect(body.githubError).toContain("Reconnect GitHub");
    expect(mocks.detail).not.toHaveBeenCalled();
  });
});
