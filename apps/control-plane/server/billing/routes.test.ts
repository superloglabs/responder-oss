import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BILLING_REQUESTS_PER_MINUTE,
  BILLING_SUMMARY_TTL_MS,
  billingRoutes,
} from "./routes.js";

const mocks = vi.hoisted(() => ({
  changeAutomationPlan: vi.fn(),
  createBillingPortal: vi.fn(),
  createPayAsYouGoCheckout: vi.fn(),
  getBillingSummary: vi.fn(),
  getUsageHistory: vi.fn(),
  organizationHasCapability: vi.fn(),
  tenant: vi.fn(),
}));

vi.mock("../tenant.js", () => ({ getActiveTenant: mocks.tenant }));
vi.mock("../../../../packages/core/src/billing/autumn.js", () => ({
  cancelAutomationPlan: vi.fn(),
  changeAutomationPlan: mocks.changeAutomationPlan,
  createBillingPortal: mocks.createBillingPortal,
  createPayAsYouGoCheckout: mocks.createPayAsYouGoCheckout,
  getAutomationBillingSummary: vi.fn(),
  getBillingSummary: mocks.getBillingSummary,
  isAutomationPaidPlanId: (value: unknown) => value === "automation_pro",
  resumeAutomationPlan: vi.fn(),
}));
vi.mock("../../../../packages/core/src/billing/usage-billing.js", () => ({
  organizationUsesUsageBilling: vi.fn().mockResolvedValue(false),
  usagePeriodStart: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationHasCapability: mocks.organizationHasCapability,
}));
vi.mock("../../../../packages/core/src/db/usage-breakdown.js", () => ({
  getUsageBreakdown: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/usage-history.js", () => ({
  getUsageHistory: mocks.getUsageHistory,
  parseUsageHistoryDays: (value: string | undefined) => value === "7" ? 7 : 30,
}));
vi.mock("../../../../packages/core/src/billing/usage-charges.js", () => ({
  sandboxTimeIsBilled: () => false,
}));

const app = new Hono().route("/api/billing", billingRoutes);
mocks.organizationHasCapability.mockResolvedValue(false);
const summary = { enabled: true, usage: 3 };

// Cache and rate-limit state outlive a test, so each test uses its own workspace.
let workspaceCount = 0;
function signIn() {
  workspaceCount += 1;
  const id = `workspace-${workspaceCount}`;
  mocks.tenant.mockResolvedValue({
    ok: true,
    organizationId: id,
    role: "admin",
    user: { email: "rob@example.com", id: `user-${workspaceCount}`, name: "Rob" },
  });
}

describe("billing routes", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mocks.organizationHasCapability.mockResolvedValue(false);
  });

  it("loads the summary once for concurrent requests from a workspace", async () => {
    signIn();
    mocks.getBillingSummary.mockResolvedValue(summary);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => app.request("/api/billing")),
    );

    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
    expect(await responses[0]?.json()).toEqual({ ...summary, automations: null, usageBased: false });
    expect(mocks.getBillingSummary).toHaveBeenCalledTimes(1);
  });

  it("keeps sharing a load that takes longer than the cache window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    signIn();
    let finish: (value: typeof summary) => void = () => undefined;
    mocks.getBillingSummary.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const first = app.request("/api/billing");
    await vi.waitFor(() => expect(mocks.getBillingSummary).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(BILLING_SUMMARY_TTL_MS + 1_000);
    const second = app.request("/api/billing");
    finish(summary);

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(mocks.getBillingSummary).toHaveBeenCalledTimes(1);
  });

  it("loads again after the summary has been ready for the cache window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    signIn();
    mocks.getBillingSummary.mockResolvedValue(summary);

    await app.request("/api/billing");
    vi.advanceTimersByTime(BILLING_SUMMARY_TTL_MS);
    await app.request("/api/billing");

    expect(mocks.getBillingSummary).toHaveBeenCalledTimes(2);
  });

  it("loads again after a checkout or portal session starts", async () => {
    signIn();
    mocks.getBillingSummary.mockResolvedValue(summary);
    mocks.createPayAsYouGoCheckout.mockResolvedValue("https://checkout.example.com");
    mocks.createBillingPortal.mockResolvedValue("https://portal.example.com");

    await app.request("/api/billing");
    await app.request("/api/billing/checkout", { method: "POST" });
    await app.request("/api/billing");
    await app.request("/api/billing/portal", { method: "POST" });
    await app.request("/api/billing");

    expect(mocks.getBillingSummary).toHaveBeenCalledTimes(3);
  });

  it("loads again after a failed summary", async () => {
    signIn();
    mocks.getBillingSummary
      .mockRejectedValueOnce(new Error("Autumn is down"))
      .mockResolvedValueOnce(summary);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await app.request("/api/billing")).status).toBe(502);
    expect((await app.request("/api/billing")).status).toBe(200);
    expect(mocks.getBillingSummary).toHaveBeenCalledTimes(2);
  });

  it("loads again after the automation plan changes", async () => {
    signIn();
    mocks.getBillingSummary.mockResolvedValue(summary);
    mocks.changeAutomationPlan.mockResolvedValue({ url: null });
    mocks.organizationHasCapability.mockResolvedValue(true);

    await app.request("/api/billing");
    const change = await app.request("/api/billing/automations/plan", {
      body: JSON.stringify({ planId: "automation_pro" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await app.request("/api/billing");

    expect(change.status).toBe(200);
    expect(mocks.getBillingSummary).toHaveBeenCalledTimes(2);
  });

  it("limits how often a member can call billing", async () => {
    signIn();
    mocks.getBillingSummary.mockResolvedValue(summary);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (let count = 0; count < BILLING_REQUESTS_PER_MINUTE; count += 1) {
      expect((await app.request("/api/billing")).status).toBe(200);
    }
    const limited = await app.request("/api/billing");
    await app.request("/api/billing");
    await app.request("/api/billing");

    // One log line per window, however many requests are refused.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: "Too many requests" });
  });

  it("returns the workspace's usage history for the requested range", async () => {
    signIn();
    mocks.organizationHasCapability.mockResolvedValue(true);
    const history = { days: ["2026-10-09"], points: [], sources: {} };
    mocks.getUsageHistory.mockResolvedValue(history);

    const response = await app.request("/api/billing/usage?days=7");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(history);
    expect(mocks.getUsageHistory).toHaveBeenCalledWith({
      days: 7,
      organizationId: `workspace-${workspaceCount}`,
    });
  });

  it("hides usage history from workspaces without automations or usage billing", async () => {
    signIn();

    const response = await app.request("/api/billing/usage");

    expect(response.status).toBe(404);
    expect(mocks.getUsageHistory).not.toHaveBeenCalled();
  });

  it("rejects requests without a workspace session", async () => {
    mocks.tenant.mockResolvedValue({ error: "Unauthorized", ok: false, status: 401 });

    expect((await app.request("/api/billing")).status).toBe(401);
    expect(mocks.getBillingSummary).not.toHaveBeenCalled();
  });
});
