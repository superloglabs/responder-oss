import { expect, test } from "@playwright/test";

const agentId = "55555555-5555-4555-8555-555555555555";

const agent = {
  configuration: null,
  createdAt: "2026-09-01T10:00:00Z",
  description: "",
  enabled: true,
  id: agentId,
  investigations: [{
    completedAt: null,
    createdAt: new Date().toISOString(),
    failureReason: null,
    finding: null,
    id: "investigation",
    input: { body: "", externalEventId: "event", provider: "sentry", title: "TypeError in checkout handler" },
    isReplay: false,
    replayOfInvestigationId: null,
    status: "investigating",
    title: "TypeError in checkout handler",
  }],
  name: "Checkout errors",
  repositories: [],
  updatedAt: "2026-09-01T10:00:00Z",
  version: null,
  versionId: null,
};

test.beforeEach(async ({ context }) => {
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const organization = { id: "org", name: "Acme", slug: "acme" };
    if (path.endsWith("/get-session")) return route.fulfill({ json: {
      session: { id: "session", userId: "user", activeOrganizationId: "org", expiresAt: "2099-01-01T00:00:00Z" },
      user: { id: "user", name: "Ada Lovelace", email: "ada@example.com", emailVerified: true },
    } });
    if (path.endsWith("/organization/list")) return route.fulfill({ json: [organization] });
    if (path.endsWith("/organization/get-full-organization")) return route.fulfill({ json: organization });
    if (path === "/api/context") return route.fulfill({ json: { capabilities: [] } });
    if (path === "/api/billing") return route.fulfill({ json: { configured: false, enabled: false } });
    if (path === "/api/agents/options") return route.fulfill({ json: { accounts: [], repositories: [], resources: [], secrets: [] } });
    if (path === "/api/integrations") return route.fulfill({ json: { integrations: [] } });
    if (path === `/api/agents/${agentId}`) return route.fulfill({ json: { agent } });
    return route.fulfill({ json: {} });
  });
});

test("opens an agent on its run history and gives each tab its own URL", async ({ page }) => {
  await page.goto(`/agents/${agentId}`);
  await expect(page.getByRole("tab")).toHaveText(["Run history", "Settings"]);
  await expect(page.getByRole("tab", { name: "Run history" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("table", { name: "Agent investigations" })).toContainText("TypeError in checkout handler");

  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/settings$`));
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("table", { name: "Agent investigations" })).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
  await expect(page.getByRole("tab", { name: "Run history" })).toHaveAttribute("aria-selected", "true");
});

test("redirects the old edit URL to settings", async ({ page }) => {
  await page.goto(`/agents/${agentId}/edit`);
  await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/settings$`));
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
});
