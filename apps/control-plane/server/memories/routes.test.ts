import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const memoryId = "31313131-3131-4131-8131-313131313131";

const mocks = vi.hoisted(() => ({
  capability: vi.fn().mockResolvedValue(true),
  delete: vi.fn(),
  get: vi.fn(),
  import: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  tenant: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../tenant.js", () => ({ getActiveTenant: mocks.tenant }));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationHasCapability: mocks.capability,
}));
vi.mock(
  "../../../../packages/core/src/db/workspace-memories.js",
  async (importOriginal) => ({
    ...(await importOriginal()),
    deleteWorkspaceMemory: mocks.delete,
    getWorkspaceMemory: mocks.get,
    importWorkspaceMemories: mocks.import,
    listWorkspaceMemories: mocks.list,
    updateWorkspaceMemory: mocks.update,
  }),
);

const memories = await vi.importActual<typeof import("../../../../packages/core/src/db/workspace-memories.js")>(
  "../../../../packages/core/src/db/workspace-memories.js",
);
const app = new Hono().route("/api/memories", memoryRoutes);

const memory = {
  name: "production-regions",
  description: "Where each production cell runs",
  type: "project",
  body: "The EU cell runs in eu-west-3.",
};

function send(method: "POST" | "PUT", path: string, body: unknown) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

describe("memory routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.capability.mockResolvedValue(true);
  });
  mocks.tenant.mockResolvedValue({
    ok: true,
    organizationId,
    user: { id: userId, name: "Ash" },
  });

  it("returns not found without the automations capability", async () => {
    mocks.capability.mockResolvedValue(false);

    expect((await app.request("/api/memories")).status).toBe(404);
    expect((await send("POST", "/api/memories", memory)).status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.import).not.toHaveBeenCalled();
  });

  it("returns not found for an ID that is not a UUID", async () => {
    expect((await app.request("/api/memories/not-a-uuid")).status).toBe(404);
    expect((await send("PUT", "/api/memories/not-a-uuid", memory)).status).toBe(404);
    expect((await app.request("/api/memories/not-a-uuid", { method: "DELETE" })).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("creates a memory as the signed-in member", async () => {
    mocks.import.mockResolvedValue({ created: [{ id: memoryId, name: memory.name }], existing: [] });

    const response = await send("POST", "/api/memories", memory);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ memory: { id: memoryId } });
    expect(mocks.import).toHaveBeenCalledWith({ memories: [memory], organizationId, userId });
  });

  it("reports a name the workspace already uses", async () => {
    mocks.import.mockResolvedValue({ created: [], existing: [memory.name] });
    mocks.update.mockRejectedValue(new memories.WorkspaceMemoryError("A memory named production-regions already exists in this workspace", "name_conflict"));

    expect(await (await send("POST", "/api/memories", memory)).json()).toMatchObject({ code: "name_conflict" });
    expect((await send("POST", "/api/memories", memory)).status).toBe(409);
    expect((await send("PUT", `/api/memories/${memoryId}`, memory)).status).toBe(409);
  });

  it("refuses a memory that looks like it contains a credential", async () => {
    mocks.import.mockImplementation(memories.importWorkspaceMemories);
    mocks.update.mockImplementation(memories.updateWorkspaceMemory);
    const withPassword = { ...memory, body: "psql postgres://owner:hunter2@db.internal/app" };

    const created = await send("POST", "/api/memories", withPassword);
    expect(created.status).toBe(422);
    expect(await created.json()).toMatchObject({ code: "credential" });
    expect((await send("PUT", `/api/memories/${memoryId}`, withPassword)).status).toBe(422);
  });

  it("rejects an invalid memory before saving it", async () => {
    const response = await send("POST", "/api/memories", { ...memory, description: "Two\rlines" });

    expect(response.status).toBe(400);
    expect(mocks.import).not.toHaveBeenCalled();
  });

  it("scopes reads, changes, and deletions to the active organization", async () => {
    mocks.get.mockResolvedValue(null);
    mocks.update.mockResolvedValue(false);
    mocks.delete.mockResolvedValue(false);

    expect((await app.request(`/api/memories/${memoryId}`)).status).toBe(404);
    expect((await send("PUT", `/api/memories/${memoryId}`, memory)).status).toBe(404);
    expect((await app.request(`/api/memories/${memoryId}`, { method: "DELETE" })).status).toBe(404);
    expect(mocks.get).toHaveBeenCalledWith(organizationId, memoryId);
    expect(mocks.update).toHaveBeenCalledWith({ memory, memoryId, organizationId, userId });
    expect(mocks.delete).toHaveBeenCalledWith({ memoryId, organizationId });
  });
});
