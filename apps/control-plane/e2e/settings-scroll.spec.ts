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

const providers = [
  ["github", "GitHub"],
  ["slack", "Slack"],
  ["aws", "AWS"],
  ["sentry", "Sentry"],
  ["datadog", "Datadog"],
  ["axiom", "Axiom"],
  ["upstash", "Upstash"],
  ["langfuse", "Langfuse"],
  ["linear", "Linear"],
  ["vercel", "Vercel"],
  ["custom_mcp", "Custom MCP"],
  ["clickstack", "ClickStack"],
] as const;

async function mockSettingsApis(page: Page) {
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
      return;
    }

    if (path.endsWith("/organization/list")) {
      await route.fulfill({ json: [organization] });
      return;
    }

    if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: organization });
      return;
    }

    await route.fulfill({ json: null });
  });
  await page.route("**/api/integrations", (route) =>
    route.fulfill({
      json: {
        integrations: providers.map(([id, name]) => ({
          id,
          name,
          description: `Connect ${name} to Responder.`,
          state: "available",
          accountCount: 0,
          resourceCount: 0,
          accounts: [],
          connectUrl: `/api/integrations/${id}/start`,
          configurationUrl: null,
        })),
      },
    }),
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

test("scrolls to integrations below the viewport", async ({ page }) => {
  await mockSettingsApis(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/settings");

  const lastIntegration = page.getByRole("button", { name: /ClickStack/ });
  await expect(lastIntegration).not.toBeInViewport();

  await page.mouse.wheel(0, 2_000);

  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(lastIntegration).toBeInViewport();
});
