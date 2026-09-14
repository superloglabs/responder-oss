import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCodebaseKnowledgeRepository,
  listCodebaseKnowledgeRepositories,
} from "@responder/core/db/knowledge-base";
import { getActiveTenant } from "../tenant.js";
import { requestCodebaseKnowledgeRefresh } from "./queue.js";
import { knowledgeRoutes } from "./routes.js";

vi.mock("@responder/core/db/knowledge-base", () => ({
  getCodebaseKnowledgeRepository: vi.fn(),
  listCodebaseKnowledgeRepositories: vi.fn(),
}));
vi.mock("../tenant.js", () => ({ getActiveTenant: vi.fn() }));
vi.mock("./queue.js", () => ({ requestCodebaseKnowledgeRefresh: vi.fn() }));

const app = new Hono().route("/api/knowledge", knowledgeRoutes);
const tenant = {
  ok: true as const,
  organizationId: "10000000-0000-4000-8000-000000000000",
  user: {
    id: "20000000-0000-4000-8000-000000000000",
    name: "Test User",
    email: "test@example.com",
  },
};
const repositoryId = "30000000-0000-4000-8000-000000000000";
const repositoryRecord = {
  repository: {
    id: repositoryId,
    defaultBranch: "main",
    fullName: "example/api",
    private: true,
  },
  knowledge: null,
};

describe("repository knowledge API", () => {
  afterEach(() => vi.clearAllMocks());

  it("lists repositories for the active tenant", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(listCodebaseKnowledgeRepositories).mockResolvedValue([
      repositoryRecord,
    ]);

    const response = await app.request("/api/knowledge");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repositories: [repositoryRecord],
    });
    expect(listCodebaseKnowledgeRepositories).toHaveBeenCalledWith(
      tenant.organizationId,
    );
  });

  it("loads one repository without crossing the tenant boundary", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(getCodebaseKnowledgeRepository).mockResolvedValue(repositoryRecord);

    const response = await app.request(`/api/knowledge/${repositoryId}`);

    expect(response.status).toBe(200);
    expect(getCodebaseKnowledgeRepository).toHaveBeenCalledWith({
      organizationId: tenant.organizationId,
      repositoryId,
    });
  });

  it("queues a forced refresh for one repository", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(requestCodebaseKnowledgeRefresh).mockResolvedValue({
      jobId: "job-id",
      target: {
        defaultBranch: "main",
        fullName: "example/api",
        installationId: 123,
        organizationId: tenant.organizationId,
        private: true,
        repositoryId,
      },
    });

    const response = await app.request(
      `/api/knowledge/${repositoryId}/refresh`,
      { method: "POST" },
    );

    expect(response.status).toBe(202);
    expect(requestCodebaseKnowledgeRefresh).toHaveBeenCalledWith({
      force: true,
      organizationId: tenant.organizationId,
      repositoryId,
    });
  });

  it("does not expose queue errors to repository viewers", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(requestCodebaseKnowledgeRefresh).mockRejectedValue(
      new Error("postgres://internal-queue-host"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(
      `/api/knowledge/${repositoryId}/refresh`,
      { method: "POST" },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Unable to refresh codebase knowledge",
    });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
