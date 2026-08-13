import { expect, test } from "@playwright/test";

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

test("opens agent creation after creating a workspace", async ({ page }) => {
  let activeOrganizationId: string | null = null;

  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({
        json: {
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
        },
      });
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

  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Create a workspace" })).toBeVisible();

  await page.getByLabel("New workspace").fill("Acme");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page).toHaveURL(/\/agents\/new$/);
  await expect(page.getByRole("heading", { name: "Create agent" })).toBeVisible();
});
