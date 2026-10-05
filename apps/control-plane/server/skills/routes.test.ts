import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { skillRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const skillId = "31313131-3131-4131-8131-313131313131";
const secretId = "41414141-4141-4141-8141-414141414141";

const mocks = vi.hoisted(() => ({
  capability: vi.fn().mockResolvedValue(true),
  create: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  tenant: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../tenant.js", () => ({ getActiveTenant: mocks.tenant }));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationHasCapability: mocks.capability,
}));
vi.mock(
  "../../../../packages/core/src/db/workspace-skills.js",
  async (importOriginal) => ({
    ...(await importOriginal()),
    createWorkspaceSkill: mocks.create,
    deleteWorkspaceSkill: mocks.delete,
    getWorkspaceSkill: mocks.get,
    listWorkspaceSkills: mocks.list,
    updateWorkspaceSkill: mocks.update,
  }),
);

const { WorkspaceSkillError } = await import(
  "../../../../packages/core/src/db/workspace-skills.js"
);
const app = new Hono().route("/api/skills", skillRoutes);

const skill = {
  name: "billing-api",
  description: "Look up invoices in the billing API.",
  instructions: "Call GET /v1/invoices with $BILLING_API_KEY.",
  files: [{ path: "openapi.yaml", content: "openapi: 3.1.0\n" }],
  secretIds: [secretId],
};

function send(method: "POST" | "PUT", path: string, body: unknown) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

describe("skill routes", () => {
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

    const response = await app.request("/api/skills");

    expect(response.status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("scopes reads to the active organization", async () => {
    mocks.get.mockResolvedValue(null);

    expect((await app.request("/api/skills")).status).toBe(200);
    expect((await app.request(`/api/skills/${skillId}`)).status).toBe(404);
    expect((await app.request("/api/skills/not-a-uuid")).status).toBe(404);

    expect(mocks.list).toHaveBeenCalledWith(organizationId);
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.get).toHaveBeenCalledWith(organizationId, skillId);
  });

  it("creates a skill for the active organization and user", async () => {
    mocks.create.mockResolvedValue({ id: skillId });

    const response = await send("POST", "/api/skills", skill);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ skill: { id: skillId } });
    expect(mocks.create).toHaveBeenCalledWith({ organizationId, skill, userId });
  });

  it("rejects an invalid skill before saving it", async () => {
    const response = await send("POST", "/api/skills", {
      ...skill,
      files: [{ path: "../outside", content: "x" }],
    });

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("reports a name already in use as a conflict", async () => {
    mocks.update.mockRejectedValue(
      new WorkspaceSkillError("A skill named billing-api already exists", "name_conflict"),
    );

    const response = await send("PUT", `/api/skills/${skillId}`, skill);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "name_conflict" });
  });

  it("refuses to delete a skill an automation uses", async () => {
    mocks.delete.mockRejectedValue(
      new WorkspaceSkillError("Remove this skill from Triage before deleting it", "in_use"),
    );

    const response = await app.request(`/api/skills/${skillId}`, { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(mocks.delete).toHaveBeenCalledWith({ organizationId, skillId });
  });
});
