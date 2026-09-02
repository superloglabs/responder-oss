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
  ["gcp", "Google Cloud"],
  ["sentry", "Sentry"],
  ["datadog", "Datadog"],
  ["axiom", "Axiom"],
  ["upstash", "Upstash"],
  ["langfuse", "Langfuse"],
  ["supabase", "Supabase"],
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

test("prepares a Google Cloud connection", async ({ page }) => {
  await mockSettingsApis(page);
  await page.route("**/api/integrations/gcp/start", (route) =>
    route.fulfill({
      json: {
        accountId: "33333333-3333-4333-8333-333333333333",
        projectId: "responder-production",
        script: "#!/usr/bin/env bash\necho ready\n",
      },
    }),
  );
  await page.goto("/settings");

  await page.getByRole("button", { name: "Add project manually" }).click();
  await page.getByLabel("Project ID").fill("responder-production");
  await page.getByLabel("Project number").fill("123456789012");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Create the investigation identities" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Download script" })).toBeVisible();
});

test("starts Supabase OAuth with the selected project access", async ({ page }) => {
  await mockSettingsApis(page);
  let requestBody: unknown;
  await page.route("**/api/integrations/supabase/start", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      json: {
        redirectUrl: "/settings?integration=supabase&status=connected",
      },
    });
  });
  await page.goto("/settings");

  await page.getByRole("button", { name: /Supabase/ }).click();
  await page.getByLabel("Project ID").fill("abcdefghijklmnopqrst");
  await page.getByLabel("Agent access").selectOption("read_only");
  await page.getByRole("button", { name: "Continue with Supabase" }).click();

  await expect.poll(() => requestBody).toEqual({
    accessMode: "read_only",
    projectRef: "abcdefghijklmnopqrst",
    returnTo: "/settings",
  });
  await expect(page).toHaveURL(/integration=supabase&status=connected/u);
});
