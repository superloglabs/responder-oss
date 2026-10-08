import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BILLING_REQUESTS_PER_MINUTE, billingRoutes } from "./routes.js";

const mocks = vi.hoisted(() => ({
  changeAutomationPlan: vi.fn(),
  getBillingSummary: vi.fn(),
  organizationHasCapability: vi.fn(),
  tenant: vi.fn(),
}));

vi.mock("../tenant.js", () => ({ getActiveTenant: mocks.tenant }));
vi.mock("../../../../packages/core/src/billing/autumn.js", () => ({
  cancelAutomationPlan: vi.fn(),
  changeAutomationPlan: mocks.changeAutomationPlan,
  createBillingPortal: vi.fn(),
  createPayAsYouGoCheckout: vi.fn(),
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
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (let count = 0; count < BILLING_REQUESTS_PER_MINUTE; count += 1) {
      expect((await app.request("/api/billing")).status).toBe(200);
    }
    const limited = await app.request("/api/billing");

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: "Too many requests" });
  });

  it("rejects requests without a workspace session", async () => {
    mocks.tenant.mockResolvedValue({ error: "Unauthorized", ok: false, status: 401 });

    expect((await app.request("/api/billing")).status).toBe(401);
    expect(mocks.getBillingSummary).not.toHaveBeenCalled();
  });
});
