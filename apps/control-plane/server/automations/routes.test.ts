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
  analytics: vi.fn(),
  getShare: vi.fn(),
  share: vi.fn(),
  unshare: vi.fn(),
  credential: vi.fn(),
  modelCatalog: vi.fn(),
  queueFollowUp: vi.fn(),
  queueRun: vi.fn(),
  tenant: vi.fn().mockResolvedValue({
    ok: true,
    organizationId: "15151515-1515-4515-8515-151515151515",
    user: { id: "21212121-2121-4121-8121-212121212121", name: "Ash" },
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
vi.mock("../../../../packages/core/src/db/shared-automation-templates.js", () => ({
  getAutomationShare: mocks.getShare,
  shareAutomation: mocks.share,
  unshareAutomation: mocks.unshare,
}));
vi.mock("../../../../packages/core/src/analytics.js", () => ({
  captureAnalyticsEvent: mocks.analytics,
}));
vi.mock("./queue.js", () => ({
  queueAutomationRun: mocks.queueRun,
  queueAutomationRunFollowUp: mocks.queueFollowUp,
}));

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
      user: { id: userId, name: "Ash" },
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

  it("starts a test chat with the member's first message", async () => {
    const automationId = "31313131-3131-4131-8131-313131313131";
    mocks.getAutomation.mockResolvedValue({ id: automationId });
    mocks.queueRun.mockResolvedValue({ duplicate: false, runId: "run-1" });

    const response = await app.request(`/api/automations/${automationId}/runs`, {
      body: JSON.stringify({ message: "  Checkout returns a 500\nfor guest users  " }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(202);
    expect(mocks.queueRun).toHaveBeenCalledWith({
      automationId,
      message: { authorId: userId, authorName: "Ash", text: "Checkout returns a 500\nfor guest users" },
      trigger: expect.objectContaining({
        body: "Checkout returns a 500\nfor guest users",
        provider: "manual",
        title: "Checkout returns a 500",
      }),
    });
  });

  it("keeps a run without a body as a plain manual run", async () => {
    const automationId = "31313131-3131-4131-8131-313131313131";
    mocks.getAutomation.mockResolvedValue({ id: automationId });
    mocks.queueRun.mockResolvedValue({ duplicate: false, runId: "run-1" });

    const response = await app.request(`/api/automations/${automationId}/runs`, { method: "POST" });
    const empty = await app.request(`/api/automations/${automationId}/runs`, {
      body: JSON.stringify({ message: "   " }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(202);
    expect(mocks.queueRun).toHaveBeenCalledWith({
      automationId,
      trigger: expect.objectContaining({ provider: "manual", title: "Manual run" }),
    });
    expect(empty.status).toBe(400);
    expect(mocks.queueRun).toHaveBeenCalledOnce();
  });

  it("queues a follow-up for a finished run in the active organization", async () => {
    const runId = "41414141-4141-4141-8141-414141414141";
    mocks.queueFollowUp.mockResolvedValue({ jobId: "job-1" });

    const response = await app.request(`/api/automations/runs/${runId}/messages`, {
      body: JSON.stringify({ message: "Please add a regression test." }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(202);
    expect(mocks.queueFollowUp).toHaveBeenCalledWith({
      message: { authorId: userId, authorName: "Ash", text: "Please add a regression test." },
      organizationId,
      runId,
    });
  });

  it("explains why a run cannot take a follow-up", async () => {
    const runId = "41414141-4141-4141-8141-414141414141";
    const send = () => app.request(`/api/automations/runs/${runId}/messages`, {
      body: JSON.stringify({ message: "Continue" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    mocks.queueFollowUp.mockResolvedValue(null);

    mocks.getAutomationRun.mockResolvedValueOnce({ automationEnabled: true });
    const active = await send();
    mocks.getAutomationRun.mockResolvedValueOnce({ automationEnabled: false });
    const disabled = await send();
    mocks.getAutomationRun.mockResolvedValueOnce(null);
    const missing = await send();

    expect(active.status).toBe(409);
    expect(await active.json()).toEqual({ error: "Wait for this run to finish before sending a follow-up." });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({ error: "Turn the automation on to continue this run." });
    expect(missing.status).toBe(404);
    expect(mocks.getAutomationRun).toHaveBeenCalledWith(organizationId, runId);
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

  describe("sharing", () => {
    const automationId = "31313131-3131-4131-8131-313131313131";
    const share = { connectors: ["github"], description: "", name: "Triage", prompt: "Rate it.", slug: "aB3_-xYz09aB3_-x", triggers: [], updatedAt: new Date("2026-09-25T10:00:00Z") };

    it("shares an automation of the active organization", async () => {
      mocks.share.mockResolvedValue({ created: true, share });

      const response = await app.request(`/api/automations/${automationId}/share`, { method: "PUT" });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ share: { slug: share.slug } });
      expect(mocks.share).toHaveBeenCalledWith({ automationId, organizationId, userId });
      expect(mocks.analytics).toHaveBeenCalledWith(expect.objectContaining({
        event: "automation template shared",
        properties: { automation_id: automationId, template_slug: share.slug, updated: false },
      }));
    });

    it("updates an existing share in place", async () => {
      mocks.share.mockResolvedValue({ created: false, share });

      const response = await app.request(`/api/automations/${automationId}/share`, { method: "PUT" });

      expect(response.status).toBe(200);
    });

    it("returns not found for another organization's automation", async () => {
      mocks.share.mockResolvedValue(null);

      const response = await app.request(`/api/automations/${automationId}/share`, { method: "PUT" });

      expect(response.status).toBe(404);
      expect(mocks.analytics).not.toHaveBeenCalled();
    });

    it("returns not found for a malformed automation ID without a query", async () => {
      const response = await app.request("/api/automations/not-a-uuid/share");

      expect(response.status).toBe(404);
      expect(mocks.getShare).not.toHaveBeenCalled();
    });

    it("does not share when the organization capability is disabled", async () => {
      mocks.capability.mockResolvedValue(false);

      const response = await app.request(`/api/automations/${automationId}/share`, { method: "PUT" });

      expect(response.status).toBe(404);
      expect(mocks.share).not.toHaveBeenCalled();
    });

    it("reads and stops the share within the active organization", async () => {
      mocks.getShare.mockResolvedValue(share);
      mocks.unshare.mockResolvedValue(true);

      const read = await app.request(`/api/automations/${automationId}/share`);
      const stopped = await app.request(`/api/automations/${automationId}/share`, { method: "DELETE" });

      await expect(read.json()).resolves.toMatchObject({ share: { slug: share.slug } });
      expect(mocks.getShare).toHaveBeenCalledWith(organizationId, automationId);
      expect(stopped.status).toBe(200);
      expect(mocks.unshare).toHaveBeenCalledWith(organizationId, automationId);
    });

    it("records the shared template an automation was created from", async () => {
      mocks.createAutomation.mockResolvedValue({ id: automationId });

      const response = await app.request("/api/automations", {
        body: JSON.stringify({
          configuration: {
            harness: "codex",
            maxModelRequests: 24,
            maxOutputTokensPerRequest: 16_000,
            maxRuntimeSeconds: 1_800,
            model: "gpt-5.4",
            modelProvider: "openai",
            prompt: "Rate it.",
            repositoryIds: ["41414141-4141-4141-8141-414141414141"],
            toolPolicy: "full",
            triggers: [{ frequency: "daily", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 }],
          },
          name: "Triage",
          sharedTemplate: share.slug,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(201);
      expect(mocks.analytics).toHaveBeenCalledWith(expect.objectContaining({
        event: "automation created",
        properties: expect.objectContaining({ shared_template_slug: share.slug, trigger_kinds: "schedule" }),
      }));
    });
  });
});
