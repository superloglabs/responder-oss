import { expect, test } from "@playwright/test";

test("mobile navigation stays available and isolates the open drawer", async ({ page }) => {
  const organization = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Acme",
    slug: "acme-workspace-id",
    createdAt: new Date().toISOString(),
    logo: null,
    metadata: null,
  };

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
  await page.route("**/api/context", (route) => route.fulfill({ json: { capabilities: [] } }));
  await page.route("**/api/legacy-account-redirect", (route) =>
    route.fulfill({ json: { redirect: false } }),
  );
  await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: [] } }));
  await page.route("**/api/billing", (route) => route.fulfill({ json: { configured: false, enabled: false } }));
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/agents");

  const surface = page.locator(".workspaceSurface");
  const bar = page.locator(".mobileSidebarBar");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await page.locator(".workspaceContent").evaluate((element) => {
    (element as HTMLElement).style.minHeight = "1800px";
  });
  await surface.evaluate((element) => { element.scrollTop = 400; });
  await expect.poll(() => bar.evaluate((element) => Math.round(element.getBoundingClientRect().top)))
    .toBeGreaterThanOrEqual(0);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveAttribute("aria-modal", "true");
  await expect(surface).toHaveAttribute("inert", "");
  await expect(page.locator(".appShell")).toHaveCSS("overflow-y", "hidden");
  await expect(surface).toHaveCSS("overflow-y", "hidden");

  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(surface).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
});
