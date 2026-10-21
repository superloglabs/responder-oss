import { expect, test, type Page } from "@playwright/test";

const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme-workspace-id",
  createdAt: new Date().toISOString(),
  logo: null,
  metadata: null,
};

const user = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Ada Lovelace",
  email: "ada@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const member = {
  id: "33333333-3333-4333-8333-333333333333",
  createdAt: new Date().toISOString(),
  organizationId: organization.id,
  role: "admin",
  user,
  userId: user.id,
};

const plans = [
  { id: "responder_plan_pro", included: 100, includesTeammates: false, machineHours: 50, name: "Pro", price: 100 },
  { id: "responder_plan_team", included: 200, includesTeammates: true, machineHours: 500, name: "Team", price: 200 },
];

// A workspace on Pro, or on Team when invitations do not need it.
function billing(invitationsNeedTeamPlan: boolean) {
  const plan = invitationsNeedTeamPlan ? plans[0] : plans[1];
  return {
    automations: {
      allowance: plan.included,
      breakdown: null,
      cancelsAtPeriodEnd: false,
      configured: true,
      creditOverageAllowed: true,
      enabled: true,
      includesTeammates: plan.includesTeammates,
      machineHours: {
        granted: plan.machineHours,
        nextResetAt: null,
        overageAllowed: true,
        remaining: plan.machineHours,
        usage: 0,
      },
      nextResetAt: null,
      paid: true,
      planId: plan.id,
      planName: plan.name,
      planPrice: plan.price,
      plans,
      remaining: plan.included,
      sandboxTimeBilled: false,
      scheduledPlanId: null,
      scheduledPlanName: null,
      usage: 0,
    },
    configured: true,
    enabled: true,
    included: 50,
    invitationsNeedTeamPlan,
    nextResetAt: null,
    overagePrice: 1.5,
    payAsYouGo: true,
    remaining: 50,
    usage: 0,
    usageBased: true,
  };
}

async function mockWorkspace(
  page: Page,
  options: { billing: ReturnType<typeof billing>; invitation?: { body: unknown; status: number } },
) {
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/get-session")) {
      await route.fulfill({
        json: {
          session: {
            id: "session-id",
            userId: user.id,
            activeOrganizationId: organization.id,
            token: "session-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          user,
        },
      });
    } else if (path.endsWith("/organization/list")) {
      await route.fulfill({ json: [organization] });
    } else if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: { ...organization, invitations: [], members: [member] } });
    } else if (path.endsWith("/organization/get-active-member")) {
      await route.fulfill({ json: member });
    } else if (path.endsWith("/organization/invite-member") && options.invitation) {
      await route.fulfill({ json: options.invitation.body, status: options.invitation.status });
    } else {
      await route.fulfill({ json: null });
    }
  });
  await page.route("**/api/context", (route) =>
    route.fulfill({ json: { capabilities: ["automations", "simplified_navigation"] } }));
  await page.route("**/api/legacy-account-redirect", (route) =>
    route.fulfill({ json: { redirect: false } }));
  await page.route("**/api/integrations/github/pull-request-author", (route) =>
    route.fulfill({ json: { author: null, canRemove: false } }));
  await page.route("**/api/billing", (route) => route.fulfill({ json: options.billing }));
  await page.route("**/api/billing/usage?**", (route) =>
    route.fulfill({ json: { days: [], points: [], sources: {} } }));
}

test("offers Team instead of the invite form on a plan with one seat", async ({ page }) => {
  await mockWorkspace(page, { billing: billing(true) });
  await page.goto("/settings/workspace");

  await expect(page.getByRole("heading", { name: "Invite teammates on the Team plan" })).toBeVisible();
  await expect(page.getByText(
    "Your plan includes one seat. Team includes unlimited seats, $200 of usage credit and 500 machine hours each month, for $200 / month.",
  )).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveCount(0);

  await page.getByRole("link", { name: "Upgrade to Team" }).click();

  const choosePlan = page.getByRole("dialog", { name: "Choose a plan" });
  await expect(choosePlan).toBeVisible();
  await expect(choosePlan.getByRole("article", { name: "Team" }).getByText("Recommended")).toBeVisible();
  await expect(choosePlan.getByRole("button", { name: "Upgrade to Team" })).toBeVisible();
});

test("keeps the invite form on a plan with teammates", async ({ page }) => {
  await mockWorkspace(page, { billing: billing(false) });
  await page.goto("/settings/workspace");

  await expect(page.getByRole("heading", { name: "Invite a teammate" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invite teammates on the Team plan" })).toHaveCount(0);
});

test("offers Team when the server refuses an invitation for the plan", async ({ page }) => {
  await mockWorkspace(page, {
    billing: billing(false),
    invitation: {
      body: { code: "TEAM_PLAN_REQUIRED", message: "Inviting teammates needs the Team plan." },
      status: 403,
    },
  });
  await page.goto("/settings/workspace");

  await page.getByLabel("Email address").fill("grace@example.com");
  await page.getByRole("button", { name: "Invite", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Invite teammates on the Team plan" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Upgrade to Team" })).toBeVisible();
  await expect(page.getByText("Inviting teammates needs the Team plan.")).toHaveCount(0);
});
