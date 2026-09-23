import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { automationRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";

const mocks = vi.hoisted(() => ({
  capability: vi.fn().mockResolvedValue(true),
  createAutomation: vi.fn(),
  getAutomation: vi.fn(),
  getAutomationRun: vi.fn(),
  listAutomations: vi.fn().mockResolvedValue([]),
  listCredentials: vi.fn().mockResolvedValue([]),
  queueRun: vi.fn(),
  tenant: vi.fn().mockResolvedValue({
    ok: true,
    organizationId: "15151515-1515-4515-8515-151515151515",
    user: { id: "21212121-2121-4121-8121-212121212121" },
  }),
}));

vi.mock("../tenant.js", () => ({ getActiveTenant: mocks.tenant }));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationHasCapability: mocks.capability,
}));
vi.mock("../../../../packages/core/src/db/automations.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createAutomation: mocks.createAutomation,
  getAutomation: mocks.getAutomation,
  getAutomationRun: mocks.getAutomationRun,
  listAutomations: mocks.listAutomations,
  requestAutomationRunCancellation: vi.fn(),
  setAutomationEnabled: vi.fn(),
  updateAutomation: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  listAgentOptions: vi.fn().mockResolvedValue({
    accounts: [],
    repositories: [],
    resources: [],
    secrets: [],
  }),
}));
vi.mock("../../../../packages/core/src/db/automation-model-credentials.js", () => ({
  createOrganizationModelCredential: vi.fn(),
  deleteOrganizationModelCredential: vi.fn(),
  getOrganizationModelCredential: vi.fn(),
  listOrganizationModelCredentials: mocks.listCredentials,
  markOrganizationModelCredentialValidated: vi.fn(),
  rotateOrganizationModelCredential: vi.fn(),
}));
vi.mock("./queue.js", () => ({ queueAutomationRun: mocks.queueRun }));

const app = new Hono().route("/api/automations", automationRoutes);

describe("automation control-plane routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.capability.mockResolvedValue(true);
    mocks.tenant.mockResolvedValue({
      ok: true,
      organizationId,
      user: { id: userId },
    });
  });

  it("returns not found when the organization capability is disabled", async () => {
    mocks.capability.mockResolvedValue(false);

    const response = await app.request("/api/automations");

    expect(response.status).toBe(404);
    expect(mocks.listAutomations).not.toHaveBeenCalled();
  });

  it("always scopes list and detail reads to the active organization", async () => {
    mocks.getAutomation.mockResolvedValue(null);

    const list = await app.request("/api/automations");
    const detail = await app.request(
      "/api/automations/31313131-3131-4131-8131-313131313131",
    );

    expect(list.status).toBe(200);
    expect(detail.status).toBe(404);
    expect(mocks.listAutomations).toHaveBeenCalledWith(organizationId);
    expect(mocks.getAutomation).toHaveBeenCalledWith(
      organizationId,
      "31313131-3131-4131-8131-313131313131",
    );
  });

  it("returns only redacted model credential metadata", async () => {
    mocks.listCredentials.mockResolvedValue([{
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
      id: "41414141-4141-4141-8141-414141414141",
      label: "Production key",
      lastFour: "1234",
      lastValidatedAt: null,
      provider: "openai",
      status: "active",
      updatedAt: new Date("2026-09-22T00:00:00.000Z"),
    }]);

    const response = await app.request("/api/automations/credentials");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Production key");
    expect(body).toContain("1234");
    expect(body).not.toContain("apiKey");
    expect(body).not.toContain("encryptedCredentials");
  });
});
