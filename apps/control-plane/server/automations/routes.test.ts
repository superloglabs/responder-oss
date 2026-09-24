import { ModelCatalogError } from "../../../../packages/core/src/automations/model-catalog.js";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { automationRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";

const mocks = vi.hoisted(() => ({
  gatewayModels: vi.fn(),
  startSubscription: vi.fn(),
  pollSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  capability: vi.fn().mockResolvedValue(true),
  createAutomation: vi.fn(),
  getAutomation: vi.fn(),
  getAutomationRun: vi.fn(),
  listAutomationRuns: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
  listAutomations: vi.fn().mockResolvedValue([]),
  listCredentials: vi.fn().mockResolvedValue([]),
  credential: vi.fn(),
  modelCatalog: vi.fn(),
  queueRun: vi.fn(),
  tenant: vi.fn().mockResolvedValue({
    ok: true,
    organizationId: "15151515-1515-4515-8515-151515151515",
    user: { id: "21212121-2121-4121-8121-212121212121" },
  }),
}));

vi.mock("../../../../packages/core/src/automations/model-pricing.js", () => ({
  listAIGatewayModels: mocks.gatewayModels,
}));
vi.mock("../tenant.js", () => ({ getActiveTenant: mocks.tenant }));
vi.mock(
  "../../../../packages/core/src/db/organization-capabilities.js",
  () => ({
    organizationHasCapability: mocks.capability,
  }),
);
vi.mock(
  "../../../../packages/core/src/db/automations.js",
  async (importOriginal) => ({
    ...(await importOriginal()),
    createAutomation: mocks.createAutomation,
    getAutomation: mocks.getAutomation,
    getAutomationRun: mocks.getAutomationRun,
    listAutomationRuns: mocks.listAutomationRuns,
    listAutomations: mocks.listAutomations,
    requestAutomationRunCancellation: vi.fn(),
    setAutomationEnabled: vi.fn(),
    updateAutomation: vi.fn(),
  }),
);
vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  listAgentOptions: vi.fn().mockResolvedValue({
    accounts: [],
    repositories: [],
    resources: [],
    secrets: [],
  }),
}));
vi.mock(
  "../../../../packages/core/src/db/automation-model-credentials.js",
  () => ({
    createOrganizationModelCredential: vi.fn(),
    deleteOrganizationModelCredential: vi.fn(),
    getOrganizationModelCredential: mocks.credential,
    listOrganizationModelCredentials: mocks.listCredentials,
    markOrganizationModelCredentialValidated: vi.fn(),
    rotateOrganizationModelCredential: vi.fn(),
  }),
);
vi.mock("../../../../packages/core/src/db/model-subscriptions.js", () => ({
  startModelSubscription: mocks.startSubscription,
  pollModelSubscription: mocks.pollSubscription,
  cancelModelSubscription: mocks.cancelSubscription,
}));
vi.mock("./queue.js", () => ({ queueAutomationRun: mocks.queueRun }));

vi.mock(
  "../../../../packages/core/src/automations/model-catalog.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../../packages/core/src/automations/model-catalog.js")
    >()),
    listProviderModels: mocks.modelCatalog,
  }),
);

const app = new Hono().route("/api/automations", automationRoutes);

describe("automation control-plane routes", () => {
  afterEach(() => {
    mocks.gatewayModels.mockReset();
    vi.clearAllMocks();
    mocks.credential.mockReset();
    mocks.modelCatalog.mockReset();
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

  it("pages run history within the active organization", async () => {
    const automationId = "31313131-3131-4131-8131-313131313131";

    const second = await app.request(`/api/automations/${automationId}/runs?page=2`);
    const invalid = await app.request(`/api/automations/${automationId}/runs?page=nope`);

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ page: 2, pageSize: 10, runs: [], total: 0 });
    expect(mocks.listAutomationRuns).toHaveBeenNthCalledWith(1, organizationId, automationId, { limit: 10, offset: 10 });
    expect(invalid.status).toBe(200);
    expect(mocks.listAutomationRuns).toHaveBeenNthCalledWith(2, organizationId, automationId, { limit: 10, offset: 0 });
  });

  it("returns only redacted model credential metadata", async () => {
    mocks.listCredentials.mockResolvedValue([
      {
        createdAt: new Date("2026-09-22T00:00:00.000Z"),
        id: "41414141-4141-4141-8141-414141414141",
        label: "Production key",
        lastFour: "1234",
        lastValidatedAt: null,
        provider: "openai",
        status: "active",
        updatedAt: new Date("2026-09-22T00:00:00.000Z"),
      },
    ]);

    const response = await app.request("/api/automations/credentials");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Production key");
    expect(body).toContain("1234");
    expect(body).not.toContain("apiKey");
    expect(body).not.toContain("encryptedCredentials");
  });

  it("scopes subscription sign-in and polling to the authenticated user and organization", async () => {
    const connectionId = "41414141-4141-4141-8141-414141414141";
    mocks.startSubscription.mockResolvedValue({
      connectionId,
      userCode: "ABCD",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    mocks.pollSubscription.mockResolvedValue({ status: "pending" });
    const start = await app.request("/api/automations/subscriptions/openai", {
      method: "POST",
    });
    expect(start.status).toBe(200);
    expect(start.headers.get("cache-control")).toBe("no-store");
    expect(mocks.startSubscription).toHaveBeenCalledWith(
      { organizationId, userId },
      expect.any(Object),
    );
    await app.request(
      `/api/automations/subscriptions/openai/${connectionId}/poll`,
      { method: "POST" },
    );
    expect(mocks.pollSubscription).toHaveBeenCalledWith(
      { organizationId, userId, connectionId },
      expect.any(Object),
    );
    await app.request(`/api/automations/subscriptions/openai/${connectionId}`, {
      method: "DELETE",
    });
    expect(mocks.cancelSubscription).toHaveBeenCalledWith(
      { organizationId, userId, connectionId },
      expect.any(Object),
    );
  });
  it("does not start a subscription login for a disabled workspace", async () => {
    mocks.startSubscription.mockClear();
    mocks.capability.mockResolvedValue(false);
    expect(
      (
        await app.request("/api/automations/subscriptions/openai", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect(mocks.startSubscription).not.toHaveBeenCalled();
    mocks.capability.mockResolvedValue(true);
  });

  it("loads models only for credentials in the authenticated workspace and never returns keys", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    mocks.credential.mockResolvedValue({
      provider: "google",
      apiKey: "private-key",
    });
    mocks.modelCatalog.mockResolvedValue([
      { id: "gemini-current", name: "Gemini" },
    ]);
    const response = await app.request(
      `/api/automations/credentials/${id}/models`,
    );
    expect(response.status).toBe(200);
    expect(mocks.credential).toHaveBeenCalledWith({
      credentialId: id,
      organizationId,
    });
    expect(mocks.modelCatalog).toHaveBeenCalledWith("google", "private-key");
    expect(await response.text()).not.toContain("private-key");
    mocks.modelCatalog.mockClear();
    mocks.credential.mockResolvedValue(null);
    expect(
      (await app.request(`/api/automations/credentials/${id}/models`)).status,
    ).toBe(404);
    expect(mocks.modelCatalog).not.toHaveBeenCalled();
  });

  it.each([
    [false, 503],
    [true, 400],
  ] as const)(
    "distinguishes provider outages from invalid keys (%s)",
    async (authenticationFailed, status) => {
      mocks.modelCatalog.mockRejectedValueOnce(
        new ModelCatalogError(authenticationFailed),
      );
      const response = await app.request("/api/automations/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          apiKey: "test-key",
          label: "Test",
        }),
      });
      expect(response.status).toBe(status);
    },
  );

  it("reports an invalid saved model key as a credential error", async () => {
    mocks.credential.mockResolvedValue({ provider: "openai", apiKey: "invalid" });
    mocks.modelCatalog.mockRejectedValueOnce(new ModelCatalogError(true));
    const response = await app.request("/api/automations/credentials/33333333-3333-4333-8333-333333333333/models");
    expect(response.status).toBe(400);
  });

  it("lists included-usage models for a provider without a connection", async () => {
    mocks.gatewayModels.mockResolvedValue([{ id: "gpt-5.4", name: "GPT-5.4" }]);

    const response = await app.request("/api/automations/included-models/openai");
    const unknown = await app.request("/api/automations/included-models/unknown");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
    });
    expect(mocks.gatewayModels).toHaveBeenCalledWith("openai");
    expect(unknown.status).toBe(400);
  });
});
