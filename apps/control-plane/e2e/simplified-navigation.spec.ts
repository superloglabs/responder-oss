import { expect, test, type Page } from "@playwright/test";

const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme-workspace-id",
  createdAt: new Date().toISOString(),
  logo: null,
  metadata: null,
};

async function mockWorkspace(page: Page, capabilities: string[]) {
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
  await page.route("**/api/context", (route) => route.fulfill({ json: { capabilities } }));
  await page.route("**/api/legacy-account-redirect", (route) =>
    route.fulfill({ json: { redirect: false } }),
  );
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { integrations: [] } }));
  await page.route("**/api/billing", (route) => route.fulfill({ json: { configured: false, enabled: false } }));
}

function primaryLinks(page: Page) {
  return page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link");
}

test("lists every product area without simplified navigation", async ({ page }) => {
  await mockWorkspace(page, ["automations"]);
  await page.goto("/settings");

  await expect(primaryLinks(page)).toHaveText([
    "Agents",
    "Automations",
    "Issues",
    "Scans",
    "Suggestions",
    "Settings",
  ]);
  await expect(primaryLinks(page).filter({ hasText: "Settings" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Tag mode" })).toBeVisible();
});

test("moves integrations and tag mode into the sidebar", async ({ page }) => {
  await mockWorkspace(page, ["automations", "simplified_navigation"]);
  await page.goto("/settings");

  await expect(primaryLinks(page)).toHaveText([
    "Automations",
    "Integrations",
    "Tag mode",
    "Settings",
  ]);
  await expect(primaryLinks(page).filter({ hasText: "Integrations" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toHaveCount(0);

  await primaryLinks(page).filter({ hasText: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/workspace$/u);
  const settingsTabs = page.getByRole("navigation", { name: "Settings sections" });
  await expect(settingsTabs.getByRole("link", { name: "Workspace" })).toBeVisible();
  await expect(settingsTabs.getByRole("link", { name: "Integrations" })).toHaveCount(0);
  await expect(settingsTabs.getByRole("link", { name: "Tag mode" })).toHaveCount(0);
});
