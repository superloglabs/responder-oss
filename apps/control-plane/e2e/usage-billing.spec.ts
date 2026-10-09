import { expect, test, type Page } from "@playwright/test";

const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme-workspace-id",
  createdAt: new Date().toISOString(),
  logo: null,
  metadata: null,
};

const plans = [
  { id: "responder_plan_pro", included: 100, machineHours: 50, name: "Pro", price: 100 },
  { id: "responder_plan_team", included: 200, machineHours: 500, name: "Team", price: 200 },
];

function machineHours(remaining: number) {
  return { granted: 2, nextResetAt: null, overageAllowed: false, remaining, usage: 2 - remaining };
}

// A workspace on the free plan from before machine hours, unless the
// overrides give it machine hours.
function billing(overrides: {
  machineHours?: ReturnType<typeof machineHours>;
  payAsYouGo?: boolean;
  remaining?: number;
  usageBased: boolean;
}) {
  const remaining = overrides.remaining ?? 12.5;
  const allowance = overrides.machineHours ? 5 : 20;
  return {
    automations: {
      allowance,
      breakdown: { inference: 5.25, sandbox: 2.25 },
      cancelsAtPeriodEnd: false,
      configured: true,
      creditOverageAllowed: false,
      enabled: true,
      machineHours: overrides.machineHours ?? null,
      nextResetAt: null,
      paid: false,
      planId: overrides.machineHours ? "responder_plan_free" : "responder_automations_free",
      planName: "Free",
      planPrice: 0,
      plans,
      remaining,
      sandboxTimeBilled: !overrides.machineHours,
      scheduledPlanId: null,
      scheduledPlanName: null,
      usage: Math.max(0, allowance - remaining),
    },
    configured: true,
    enabled: true,
    included: 50,
    nextResetAt: null,
    overagePrice: 1.5,
    payAsYouGo: overrides.payAsYouGo ?? false,
    remaining: 50,
    usage: 0,
    usageBased: overrides.usageBased,
  };
}

async function mockWorkspace(page: Page, summary: ReturnType<typeof billing>) {
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/get-session")) {
      await route.fulfill({
        json: {
          session: {
            id: "session-id",
            userId: "22222222-2222-4222-8222-222222222222",
            activeOrganizationId: organization.id,
            token: "session-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          user: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Ada Lovelace",
            email: "ada@example.com",
            emailVerified: true,
            image: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      });
    } else if (path.endsWith("/organization/list")) {
      await route.fulfill({ json: [organization] });
    } else if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: organization });
    } else {
      await route.fulfill({ json: null });
    }
  });
  await page.route("**/api/context", (route) =>
    route.fulfill({
      json: {
        capabilities: summary.usageBased
          ? ["automations", "simplified_navigation"]
          : ["automations"],
      },
    }));
  await page.route("**/api/legacy-account-redirect", (route) =>
    route.fulfill({ json: { redirect: false } }),
  );
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { integrations: [] } }));
  await page.route("**/api/automations", (route) => route.fulfill({ json: { automations: [] } }));
  await page.route("**/api/billing", (route) => route.fulfill({ json: summary }));
  await page.route("**/api/billing/usage?**", (route) => route.fulfill({ json: usageHistory }));
}

const usageHistory = {
  days: ["2026-10-07", "2026-10-08", "2026-10-09"],
  points: [
    { aiCharge: 1.5, day: "2026-10-08", machineHours: 3, source: "automation-1" },
    { aiCharge: 2.25, day: "2026-10-09", machineHours: 0.5, source: "tag_mode" },
    { aiCharge: 0.5, day: "2026-10-09", machineHours: 0, source: "pull_requests" },
  ],
  sources: {
    "automation-1": { automationId: "automation-1", kind: "automation", name: "Sentry triage" },
    pull_requests: { kind: "pull_requests" },
    tag_mode: { kind: "tag_mode" },
  },
};

test("shows only the usage allowance to a usage-billed workspace", async ({ page }) => {
  await mockWorkspace(page, billing({ usageBased: true }));
  await page.goto("/settings/billing");

  await expect(page.getByRole("heading", { exact: true, name: "Usage" })).toBeVisible();
  await expect(page.getByText("Included usage this month")).toBeVisible();
  await expect(page.getByText(/Covers model usage and sandbox time/u)).toBeVisible();
  await expect(page.getByText("Monthly investigations")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enable pay as you go" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Switch to Pro" })).toBeVisible();
});

test("shows usage credit and machine hours on plans that include machine hours", async ({ page }) => {
  await mockWorkspace(page, billing({
    machineHours: machineHours(1.5),
    remaining: 4,
    usageBased: true,
  }));
  await page.goto("/settings/billing");

  await expect(page.getByText("Usage credit", { exact: true })).toBeVisible();
  await expect(page.getByText("$4.00 of $5.00 remains. One-time credit.", { exact: false })).toBeVisible();
  await expect(page.locator(".billingMeter").getByText("Machine hours", { exact: true })).toBeVisible();
  await expect(page.getByText(/1\.5 h of 2\.0 h remain/u)).toBeVisible();
  await expect(page.locator(".billingBreakdown")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Switch to Team" })).toBeVisible();
});

test("warns a workspace when its machine hours are used up", async ({ page }) => {
  await mockWorkspace(page, billing({ machineHours: machineHours(0), usageBased: true }));
  await page.goto("/automations");

  await expect(page.getByRole("status").filter({ hasText: "Machine hours used up" })).toBeVisible();
});

test("splits used allowance into inference and sandbox compute", async ({ page }) => {
  await mockWorkspace(page, billing({ usageBased: true }));
  await page.goto("/settings/billing");

  const breakdown = page.locator(".billingBreakdown");
  await expect(breakdown.getByText("AI inference")).toBeVisible();
  await expect(breakdown.getByText("$5.25")).toBeVisible();
  await expect(breakdown.getByText("Sandbox compute")).toBeVisible();
  await expect(breakdown.getByText("$2.25")).toBeVisible();
  // $7.50 of $20 is 37.5% of the bar, split 70/30.
  const inference = await page.locator(".billingProgress__segment--inference").evaluate(
    (element) => (element as HTMLElement).style.width,
  );
  const sandbox = await page.locator(".billingProgress__segment--sandbox").evaluate(
    (element) => (element as HTMLElement).style.width,
  );
  expect(Number.parseFloat(inference)).toBeCloseTo(26.25);
  expect(Number.parseFloat(sandbox)).toBeCloseTo(11.25);
});

test("keeps billing management for a usage-billed workspace with a payment method", async ({ page }) => {
  await mockWorkspace(page, billing({ payAsYouGo: true, usageBased: true }));
  let portalOpened = false;
  await page.route("**/api/billing/portal", async (route) => {
    portalOpened = true;
    await route.fulfill({ json: { url: "/settings/billing?status=portal" } });
  });
  await page.goto("/settings/billing");

  await page.getByRole("button", { name: "Manage billing" }).click();
  await expect.poll(() => portalOpened).toBe(true);
});

test("offers no billing management before a usage-billed workspace pays", async ({ page }) => {
  await mockWorkspace(page, billing({ usageBased: true }));
  await page.goto("/settings/billing");

  await expect(page.getByRole("heading", { exact: true, name: "Usage" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage billing" })).toHaveCount(0);
});

test("keeps investigation credits for other workspaces", async ({ page }) => {
  await mockWorkspace(page, billing({ usageBased: false }));
  await page.goto("/settings/billing");

  await expect(page.getByText("Monthly investigations")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
});

test("warns a usage-billed workspace when its allowance is used", async ({ page }) => {
  await mockWorkspace(page, billing({ remaining: 0, usageBased: true }));
  await page.goto("/automations");

  await expect(page.getByRole("status").filter({ hasText: "Usage limit reached" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Upgrade plan" })).toHaveAttribute(
    "href",
    "/settings/billing",
  );
});

test("shows no banner while a paid plan bills usage past its allowance", async ({ page }) => {
  const summary = billing({ remaining: 0, usageBased: true });
  summary.automations.creditOverageAllowed = true;
  await mockWorkspace(page, summary);
  const billingLoaded = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/billing"
  );
  await page.goto("/automations");
  await billingLoaded;

  await expect(page.getByRole("heading", { name: "Automations" }).first()).toBeVisible();
  await expect(page.locator(".billingBanner")).toHaveCount(0);
});

test("charts usage by automation and tag mode", async ({ page }) => {
  await mockWorkspace(page, billing({ usageBased: true }));
  await page.goto("/settings/billing");

  await expect(page.getByRole("heading", { name: "Usage by source" })).toBeVisible();
  const legend = page.locator(".usageChart__legend");
  await expect(legend.getByRole("listitem")).toHaveText(["Sentry triage3 h", "Tag mode0.5 h"]);
  await expect(page.getByText("Machine hours, last 30 days")).toBeVisible();

  await page.getByRole("radio", { name: "AI usage" }).click();
  await expect(legend.getByRole("listitem")).toHaveText(["Sentry triage$1.50", "Tag mode$2.25", "Pull requests$0.50"]);
  await expect(page.locator(".billingUsageHistory header strong")).toHaveText("$4.25");

  await page.locator(".usageChart__column").nth(2).hover();
  await expect(page.locator(".usageChart__tooltip")).toContainText("Tag mode$2.25");

  await page.getByRole("radio", { name: "AI usage" }).press("ArrowLeft");
  await expect(page.getByRole("radio", { name: "Machine hours" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "Machine hours" })).toBeFocused();
});
