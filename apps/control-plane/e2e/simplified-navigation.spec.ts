import { expect, test, type Page } from "@playwright/test";

const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme-workspace-id",
  createdAt: new Date().toISOString(),
  logo: null,
  metadata: null,
};

async function mockWorkspace(
  page: Page,
  capabilities: string[],
  contextDelayMs = 0,
) {
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
  await page.route("**/api/context", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, contextDelayMs));
    await route.fulfill({ json: { capabilities } });
  });
  await page.route("**/api/legacy-account-redirect", (route) =>
    route.fulfill({ json: { redirect: false } }),
  );
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { integrations: [] } }));
  await page.route("**/api/automations", (route) => route.fulfill({ json: { automations: [] } }));
  await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: [] } }));
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

test("waits for capabilities before showing the sidebar", async ({ page }) => {
  await mockWorkspace(page, ["automations", "simplified_navigation"], 500);
  await page.goto("/settings");

  await expect(page.getByText("Loading Superlog…")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toHaveCount(0);
  await expect(primaryLinks(page)).toHaveText([
    "Automations",
    "Integrations",
    "Tag mode",
    "Settings",
  ]);
});

test("opens automations for simplified navigation", async ({ page }) => {
  await mockWorkspace(page, ["automations", "simplified_navigation"]);
  await page.goto("/app");

  await expect(page).toHaveURL(/\/automations$/u);
});

test("opens agents without simplified navigation", async ({ page }) => {
  await mockWorkspace(page, ["automations"]);
  await page.goto("/app");

  await expect(page).toHaveURL(/\/agents$/u);
});

test("shows the tag mode custom prompt as a Slack assistant prompt", async ({ page }) => {
  await mockWorkspace(page, ["automations", "simplified_navigation"]);
  await page.route("**/api/agents/options", (route) =>
    route.fulfill({ json: { accounts: [], repositories: [], resources: [], secrets: [] } }),
  );
  await page.route("**/api/agents/thread-mode", (route) =>
    route.fulfill({
      json: {
        configuration: {
          contextAccountIds: [],
          contextResourceIds: [],
          enabled: true,
          instructions: "Investigate the request using connected context and attached repositories. Report what you found, the supporting evidence, and the recommended next step.",
          model: "instance/default",
          repositoryIds: [],
          secretIds: [],
        },
      },
    }),
  );
  await page.goto("/settings/tag-mode");

  await expect(page.getByRole("heading", { level: 2, name: "Custom prompt" })).toBeVisible();
  await expect(page.getByLabel("Custom prompt")).toHaveValue(
    "Answer the request using the connected integrations and attached repositories. Keep replies short, and say what you changed.",
  );
  await expect(page.getByText("Let people mention Superlog in Slack to ask questions, open pull requests, and change automations and settings.")).toBeVisible();
});
