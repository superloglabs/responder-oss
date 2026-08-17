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

function sessionResponse(activeOrganizationId: string | null) {
  return {
    session: {
      id: "session-id",
      userId: user.id,
      activeOrganizationId,
      token: "session-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    user,
  };
}

async function mockApplicationApis(page: Page) {
  await page.route("**/api/agents", (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route("**/api/agents/options", (route) =>
    route.fulfill({ json: { accounts: [], resources: [], repositories: [] } }),
  );
  await page.route("**/api/integrations", (route) =>
    route.fulfill({ json: { integrations: [] } }),
  );
  await page.route("**/api/billing", (route) =>
    route.fulfill({
      json: {
        configured: false,
        enabled: false,
        payAsYouGo: false,
        remaining: 0,
      },
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await mockApplicationApis(page);
});

test("opens agent creation after creating a workspace", async ({ page }) => {
  let activeOrganizationId: string | null = null;

  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({ json: sessionResponse(activeOrganizationId) });
      return;
    }

    if (path.endsWith("/organization/list")) {
      await route.fulfill({ json: activeOrganizationId ? [organization] : [] });
      return;
    }

    if (path.endsWith("/organization/create")) {
      await route.fulfill({ json: organization });
      return;
    }

    if (path.endsWith("/organization/set-active")) {
      activeOrganizationId = organization.id;
      await route.fulfill({ json: null });
      return;
    }

    if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: organization });
      return;
    }

    await route.fulfill({ json: null });
  });
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Create a workspace" })).toBeVisible();

  await page.getByLabel("New workspace").fill("Acme");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page).toHaveURL(/\/agents\/new$/);
  await expect(page.getByRole("heading", { name: "Create agent" })).toBeVisible();
});

test("keeps an invitation link open while the recipient signs in", async ({
  page,
}) => {
  let signedIn = false;

  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({
        json: signedIn ? sessionResponse(null) : null,
      });
      return;
    }

    if (path.endsWith("/sign-in/email")) {
      signedIn = true;
      await route.fulfill({
        json: { redirect: false, token: "session-token", user },
      });
      return;
    }

    await route.fulfill({ json: null });
  });

  const invitationId = "33333333-3333-4333-8333-333333333333";
  await page.goto(`/invite/${invitationId}`);

  await expect(page).toHaveURL(new RegExp(`/invite/${invitationId}$`));
  await expect(page.getByText("Workspace invitation")).toBeVisible();
  await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();
  await expect(
    page.getByText(
      "Sign in or create an account with the invited email to join this workspace.",
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "New to Responder? Create an account" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your account to join" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Already have an account? Sign in" }).click();

  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(new RegExp(`/invite/${invitationId}$`));
  await expect(
    page.getByRole("heading", { name: "Join this workspace" }),
  ).toBeVisible();
});

test("accepts an invitation and opens its workspace", async ({ page }) => {
  const invitationId = "33333333-3333-4333-8333-333333333333";
  let activeOrganizationId: string | null = null;
  let acceptedInvitationId: string | null = null;

  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({ json: sessionResponse(activeOrganizationId) });
      return;
    }

    if (path.endsWith("/organization/accept-invitation")) {
      const request = route.request().postDataJSON() as { invitationId: string };
      acceptedInvitationId = request.invitationId;
      await route.fulfill({
        json: {
          invitation: {
            id: invitationId,
            organizationId: organization.id,
            email: user.email,
            role: "member",
            status: "accepted",
          },
          member: {
            id: "44444444-4444-4444-8444-444444444444",
            organizationId: organization.id,
            userId: user.id,
            role: "member",
          },
        },
      });
      return;
    }

    if (path.endsWith("/organization/set-active")) {
      activeOrganizationId = organization.id;
      await route.fulfill({ json: null });
      return;
    }

    if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: organization });
      return;
    }

    await route.fulfill({ json: null });
  });
  await page.goto(`/invite/${invitationId}`);
  await expect(
    page.getByRole("heading", { name: "Join this workspace" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Accept invitation" }).click();

  await expect(page).toHaveURL(/\/agents$/);
  expect(acceptedInvitationId).toBe(invitationId);
  expect(activeOrganizationId).toBe(organization.id);
});

test("redirects malformed invitation links", async ({ page }) => {
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({ json: sessionResponse(organization.id) });
      return;
    }

    await route.fulfill({ json: null });
  });

  await page.goto("/invite/xyz");

  await expect(page).toHaveURL(/\/agents$/);
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
});
