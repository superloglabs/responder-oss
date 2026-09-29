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
  { id: "responder_automations_100", included: 100, price: 100 },
  { id: "responder_automations_200", included: 200, price: 200 },
];

function billing(overrides: { remaining?: number; usageBased: boolean }) {
  const remaining = overrides.remaining ?? 12.5;
  return {
    automations: {
      allowance: 20,
      breakdown: { inference: 5.25, sandbox: 2.25 },
      cancelsAtPeriodEnd: false,
      configured: true,
      enabled: true,
      nextResetAt: null,
      planId: "responder_automations_free",
      plans,
      remaining,
      sandboxTimeBilled: true,
      scheduledPlanId: null,
      usage: 20 - remaining,
    },
    configured: true,
    enabled: true,
    included: 50,
    nextResetAt: null,
    overagePrice: 1.5,
    payAsYouGo: false,
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
}

test("shows only the usage allowance to a usage-billed workspace", async ({ page }) => {
  await mockWorkspace(page, billing({ usageBased: true }));
  await page.goto("/settings/billing");

  await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
  await expect(page.getByText("Included usage this month")).toBeVisible();
  await expect(page.getByText(/Covers model usage and sandbox time/u)).toBeVisible();
  await expect(page.getByText("Monthly investigations")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enable pay as you go" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Switch to $100 / month" })).toBeVisible();
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

test("keeps investigation credits for other workspaces", async ({ page }) => {
  await mockWorkspace(page, billing({ usageBased: false }));
  await page.goto("/settings/billing");

  await expect(page.getByText("Monthly investigations")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
});

test("warns a usage-billed workspace when its allowance is used", async ({ page }) => {
  await mockWorkspace(page, billing({ remaining: 0, usageBased: true }));
  await page.goto("/automations");

  await expect(page.getByRole("status").filter({ hasText: "Usage limit reached." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Upgrade plan" })).toHaveAttribute(
    "href",
    "/settings/billing",
  );
});
