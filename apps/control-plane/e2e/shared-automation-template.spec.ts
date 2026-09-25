import { expect, test, type BrowserContext } from "@playwright/test";

const slug = "aB3_-xYz09aB3_-x";
const repositoryId = "11111111-1111-4111-8111-111111111111";
const sentryAccountId = "22222222-2222-4222-8222-222222222222";
const slackAccountId = "44444444-4444-4444-8444-444444444444";
const template = {
  connectors: ["github", "slack"],
  description: "Rates new Sentry issues and posts a summary to Slack.",
  name: "Triage new Sentry issues",
  prompt: "Rate the issue.\nPost a summary to Slack.",
  slug,
  triggers: [
    { eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: [] },
    { frequency: "daily", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 },
  ],
  updatedAt: "2026-09-25T10:00:00Z",
  workspaceName: "Acme Robotics",
};

async function mockApi(context: BrowserContext, signedIn: boolean) {
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const organization = { id: "org", name: "Globex", slug: "globex" };
    if (path.endsWith("/get-session")) return route.fulfill({ json: signedIn ? {
      session: { id: "session", userId: "user", activeOrganizationId: "org", expiresAt: "2099-01-01T00:00:00Z" },
      user: { id: "user", name: "Grace Hopper", email: "grace@example.com", emailVerified: true },
    } : null });
    if (path === `/api/automation-templates/${slug}`) return route.fulfill({ json: { template } });
    if (path.startsWith("/api/automation-templates/")) return route.fulfill({ status: 404, json: { error: "Template not found" } });
    if (!signedIn) return route.fulfill({ status: 401, json: { error: "Unauthorized" } });
    if (path.endsWith("/organization/list")) return route.fulfill({ json: [organization] });
    if (path.endsWith("/organization/get-full-organization")) return route.fulfill({ json: organization });
    if (path === "/api/context") return route.fulfill({ json: { capabilities: ["automations"] } });
    if (path === "/api/billing") return route.fulfill({ json: { configured: false, enabled: false } });
    if (path === "/api/automations/options") return route.fulfill({ json: {
      accounts: [
        { id: sentryAccountId, provider: "sentry", displayName: "globex" },
        { id: slackAccountId, provider: "slack", displayName: "Globex" },
      ],
      credentials: [],
      repositories: [{ id: repositoryId, fullName: "globex/api" }],
      resources: [],
      secrets: [],
    } });
    if (path.startsWith("/api/automations/included-models/")) return route.fulfill({ json: { models: [{ id: "gpt-5.4", name: "GPT-5.4" }] } });
    return route.fulfill({ json: {} });
  });
}

test("shows a shared template to a signed-out visitor and sends them to sign up", async ({ context, page }, testInfo) => {
  await mockApi(context, false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/templates/${slug}`);
  await expect(page.getByRole("heading", { name: "Triage new Sentry issues" })).toBeVisible();
  await expect(page.getByText("Shared by Acme Robotics.")).toBeVisible();
  await expect(page.getByText("When Sentry reports a new issue in a project you choose")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue(template.prompt);
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).not.toBeEditable();
  await page.screenshot({ path: testInfo.outputPath("shared-template-desktop.png"), fullPage: true });

  await page.getByRole("link", { name: "Use this automation" }).click();
  await expect(page).toHaveURL(`/automations/new?shared=${slug}`);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByText("Create an account to set up this automation in your own workspace.")).toBeVisible();
});

test("fills a new automation from a shared template", async ({ context, page }) => {
  await mockApi(context, true);
  await page.goto(`/automations/new?shared=${slug}`);
  await expect(page.getByRole("heading", { name: "Triage new Sentry issues" })).toBeVisible();
  await expect(page.getByText(/shared by Acme Robotics\. Choose a Sentry project and a repository, then save\./)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue(template.prompt);
  await expect(page.getByRole("button", { name: "Remove Globex" })).toBeVisible();
});

test("explains when a shared template is no longer available", async ({ context, page }) => {
  await mockApi(context, false);
  await page.goto("/templates/zzzzzzzzzzzzzzzz");
  await expect(page.getByRole("heading", { name: "This template is no longer shared" })).toBeVisible();
});

test("keeps the shared template readable on mobile", async ({ context, page }) => {
  await mockApi(context, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/templates/${slug}`);
  await expect(page.getByRole("link", { name: "Use this automation" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
