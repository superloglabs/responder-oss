import { ModelCatalogError } from "../../../../packages/core/src/automations/model-catalog.js";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { automationWebhookToken } from "../../../../packages/core/src/integrations/webhook-secret.js";
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
  listSlackAuthors: vi.fn().mockResolvedValue([]),
  listCredentials: vi.fn().mockResolvedValue([]),
  analytics: vi.fn(),
  getShare: vi.fn(),
  getUsageHistory: vi.fn().mockResolvedValue({ days: [], points: [], sources: {} }),
  listAutomationIssues: vi.fn().mockResolvedValue({ issues: [], total: 0 }),
  share: vi.fn(),
  unshare: vi.fn(),
  credential: vi.fn(),
  modelCatalog: vi.fn(),
  queueFollowUp: vi.fn(),
  queueRun: vi.fn(),
  queueSuggestionRefill: vi.fn(),
  finishSuggestionRefill: vi.fn(),
  latestSuggestions: vi.fn(),
  removeSuggestions: vi.fn(),
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
    listSlackMessageAuthors: mocks.listSlackAuthors,
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
vi.mock("../../../../packages/core/src/db/automation-issues.js", () => ({
  listAutomationIssues: mocks.listAutomationIssues,
}));
vi.mock("../../../../packages/core/src/db/usage-history.js", async (original) => ({
  ...(await original<typeof import("../../../../packages/core/src/db/usage-history.js")>()),
  getUsageHistory: mocks.getUsageHistory,
}));
vi.mock("../../../../packages/core/src/analytics.js", () => ({
  captureAnalyticsEvent: mocks.analytics,
}));
vi.mock("./queue.js", () => ({
  queueAutomationRun: mocks.queueRun,
  queueAutomationRunFollowUp: mocks.queueFollowUp,
  queueAutomationSuggestionRefill: mocks.queueSuggestionRefill,
}));
vi.mock("../../../../packages/core/src/db/automation-template-suggestions.js", () => ({
  finishAutomationSuggestionRefill: mocks.finishSuggestionRefill,
  getLatestAutomationSuggestions: mocks.latestSuggestions,
  removeAutomationSuggestions: mocks.removeSuggestions,
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

  it("lists the Slack authors of the selected channels in the active organization", async () => {
    const accountId = "41414141-4141-4141-8141-414141414141";
    mocks.listSlackAuthors.mockResolvedValue([{ id: "A123", kind: "app", name: "Devin" }]);

    const response = await app.request(`/api/automations/slack/${accountId}/authors?channel=C1&channel=C2`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authors: [{ id: "A123", kind: "app", name: "Devin" }] });
    expect(mocks.listSlackAuthors).toHaveBeenCalledWith({
      channelIds: ["C1", "C2"],
      integrationAccountId: accountId,
      organizationId,
    });
    expect((await app.request("/api/automations/slack/not-a-uuid/authors?channel=C1")).status).toBe(400);
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

  it("pages an automation's issues within the active organization", async () => {
    const automationId = "31313131-3131-4131-8131-313131313131";
    mocks.listAutomationIssues.mockResolvedValueOnce({
      issues: [{
        filedRunId: "41414141-4141-4141-8141-414141414141",
        firstSeenAt: new Date("2026-10-12T06:02:00.000Z"),
        id: "51515151-5151-4151-8151-515151515151",
        lastSeenAt: new Date("2026-10-12T06:28:00.000Z"),
        links: [],
        occurrences: 207,
        slackMessages: [],
        summary: "Validation checks return 504.",
        title: "US sync checks time out",
      }],
      total: 26,
    });

    const response = await app.request(`/api/automations/${automationId}/issues?page=2`);
    const malformed = await app.request("/api/automations/not-a-uuid/issues");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issues: [{
        filedRunId: "41414141-4141-4141-8141-414141414141",
        firstSeenAt: "2026-10-12T06:02:00.000Z",
        id: "51515151-5151-4151-8151-515151515151",
        lastSeenAt: "2026-10-12T06:28:00.000Z",
        links: [],
        occurrences: 207,
        slackMessages: [],
        summary: "Validation checks return 504.",
        title: "US sync checks time out",
      }],
      page: 2,
      pageSize: 25,
      total: 26,
    });
    expect(mocks.listAutomationIssues).toHaveBeenCalledWith({ automationId, limit: 25, offset: 25, organizationId });
    expect(malformed.status).toBe(404);
    expect(mocks.listAutomationIssues).toHaveBeenCalledTimes(1);
  });

  it("reads an automation's usage within the active organization", async () => {
    const automationId = "31313131-3131-4131-8131-313131313131";

    const response = await app.request(`/api/automations/${automationId}/usage?days=90`);
    const fallback = await app.request(`/api/automations/${automationId}/usage?days=365`);
    const malformed = await app.request("/api/automations/not-a-uuid/usage");

    expect(response.status).toBe(200);
    expect(mocks.getUsageHistory).toHaveBeenNthCalledWith(1, { automationId, days: 90, organizationId });
    expect(fallback.status).toBe(200);
    expect(mocks.getUsageHistory).toHaveBeenNthCalledWith(2, { automationId, days: 30, organizationId });
    expect(malformed.status).toBe(404);
    expect(mocks.getUsageHistory).toHaveBeenCalledTimes(2);
  });

  it("shows the webhook URL and token of an automation in the active organization", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://app.responder.example");
    const automationId = "31313131-3131-4131-8131-313131313131";
    mocks.getAutomation.mockResolvedValueOnce({ id: automationId }).mockResolvedValueOnce(null);

    const response = await app.request(`/api/automations/${automationId}/webhook`);
    const missing = await app.request(`/api/automations/${automationId}/webhook`);
    const malformed = await app.request("/api/automations/not-a-uuid/webhook");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: automationWebhookToken(automationId),
      url: `https://app.responder.example/api/webhooks/automations/${automationId}`,
    });
    expect(mocks.getAutomation).toHaveBeenCalledWith(organizationId, automationId);
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(mocks.getAutomation).toHaveBeenCalledTimes(2);
    vi.unstubAllEnvs();
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

    it("removes the suggestion an automation was created from and queues a replacement", async () => {
      const suggestionId = "51515151-5151-4515-8515-515151515151";
      mocks.createAutomation.mockResolvedValue({ id: automationId });
      mocks.removeSuggestions.mockResolvedValue({
        kind: "removed",
        refillRequested: true,
        suggestions: { canRefresh: true, generatedOn: "2026-10-16", refreshing: true, templates: [] },
      });

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
          suggestedTemplate: suggestionId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(201);
      expect(mocks.removeSuggestions).toHaveBeenCalledWith(expect.objectContaining({ organizationId, templateIds: [suggestionId] }));
      expect(mocks.queueSuggestionRefill).toHaveBeenCalledWith({ generatedOn: "2026-10-16", organizationId });
    });

    it("explains a duplicate automation name instead of failing", async () => {
      // Drizzle reports the Postgres violation as the cause of its own error.
      mocks.createAutomation.mockRejectedValue(new Error("Failed query", {
        cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
          constraint: "automations_organization_name_idx",
        }),
      }));

      const response = await app.request("/api/automations", {
        body: JSON.stringify({
          configuration: {
            harness: "codex",
            maxModelRequests: 128,
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
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "automation_name_taken",
        error: 'An automation named "Triage" already exists. Choose a different name.',
      });
    });
  });
  describe("suggested templates", () => {
    const suggestionId = "51515151-5151-4515-8515-515151515151";
    const shown = { canRefresh: true, generatedOn: "2026-10-16", refreshing: true, templates: [{ id: "next" }] };

    it("dismisses a suggestion and queues its replacement", async () => {
      mocks.removeSuggestions.mockResolvedValue({ kind: "removed", refillRequested: true, suggestions: shown });

      const response = await app.request(`/api/automations/suggestions/${suggestionId}/dismiss`, { method: "POST" });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ canRefresh: true, generatedOn: "2026-10-16", refreshing: true, suggestions: [{ id: "next" }] });
      expect(mocks.removeSuggestions).toHaveBeenCalledWith(expect.objectContaining({ organizationId, templateIds: [suggestionId] }));
      expect(mocks.queueSuggestionRefill).toHaveBeenCalledWith({ generatedOn: "2026-10-16", organizationId });
    });

    it("closes the request when the replacement cannot be queued", async () => {
      mocks.removeSuggestions.mockResolvedValue({ kind: "removed", refillRequested: true, suggestions: shown });
      mocks.queueSuggestionRefill.mockRejectedValueOnce(new Error("queue down"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await app.request(`/api/automations/suggestions/${suggestionId}/dismiss`, { method: "POST" });

      await expect(response.json()).resolves.toMatchObject({ refreshing: false });
      expect(mocks.finishSuggestionRefill).toHaveBeenCalledWith(expect.objectContaining({ generatedOn: "2026-10-16", organizationId, templates: [] }));
      logged.mockRestore();
    });

    it("does not queue when the day has no replacements left", async () => {
      mocks.removeSuggestions.mockResolvedValue({ kind: "removed", refillRequested: false, suggestions: { ...shown, canRefresh: false, refreshing: false } });

      const response = await app.request(`/api/automations/suggestions/${suggestionId}/dismiss`, { method: "POST" });

      expect(response.status).toBe(200);
      expect(mocks.queueSuggestionRefill).not.toHaveBeenCalled();
    });

    it("rejects an unknown suggestion", async () => {
      mocks.removeSuggestions.mockResolvedValue({ kind: "none" });

      expect((await app.request("/api/automations/suggestions/not-an-id/dismiss", { method: "POST" })).status).toBe(400);
      expect((await app.request(`/api/automations/suggestions/${suggestionId}/dismiss`, { method: "POST" })).status).toBe(404);
    });

    it("refreshes every suggestion until the day's limit", async () => {
      mocks.removeSuggestions.mockResolvedValueOnce({ kind: "removed", refillRequested: true, suggestions: { ...shown, templates: [] } });

      const refreshed = await app.request("/api/automations/suggestions/refresh", { method: "POST" });

      expect(refreshed.status).toBe(200);
      expect(mocks.removeSuggestions).toHaveBeenCalledWith(expect.objectContaining({ organizationId, templateIds: "all" }));

      mocks.removeSuggestions.mockResolvedValueOnce({ kind: "limit", suggestions: { ...shown, canRefresh: false, refreshing: false } });
      const limited = await app.request("/api/automations/suggestions/refresh", { method: "POST" });

      expect(limited.status).toBe(429);
      await expect(limited.json()).resolves.toMatchObject({ error: "No more suggestions today. New ones arrive tomorrow morning.", suggestions: [{ id: "next" }] });
    });
  });
});
