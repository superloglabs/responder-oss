import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Superlog",
  slug: "superlog",
  createdAt: new Date().toISOString(),
  logo: null,
  metadata: null,
};
const eu = { id: "eu", label: "Europe", url: "https://superlog.sh" };
const us = { id: "us", label: "United States", url: "https://us.superlog.sh" };
const ali = {
  banned: false,
  canImpersonate: true,
  createdAt: "2026-10-26T10:00:00.000Z",
  email: "ali@nautilus.co",
  id: "44444444-4444-4444-8444-444444444444",
  image: null,
  name: "Ali",
  role: "user",
};
const ana = {
  ...ali,
  createdAt: "2026-10-01T10:00:00.000Z",
  email: "ana@example.com",
  id: "55555555-5555-4555-8555-555555555555",
  name: "Ana",
};

async function mockSuperuser(page: Page, users: unknown, onImpersonate?: (body: unknown) => void) {
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
            email: "ada@superlog.sh",
            emailVerified: true,
            image: null,
            role: "superuser",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      });
    } else if (path.endsWith("/admin/impersonate-user")) {
      onImpersonate?.(route.request().postDataJSON());
      await route.fulfill({ json: { session: {}, user: {} } });
    } else if (path.endsWith("/organization/list")) {
      await route.fulfill({ json: [organization] });
    } else if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: organization });
    } else {
      await route.fulfill({ json: null });
    }
  });
  await page.route("**/api/context", (route) => route.fulfill({ json: { capabilities: [] } }));
  await page.route("**/api/legacy-account-redirect", (route) => route.fulfill({ json: { redirect: false } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { integrations: [] } }));
  await page.route("**/api/automations", (route) => route.fulfill({ json: { automations: [] } }));
  await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: [] } }));
  await page.route("**/api/billing", (route) => route.fulfill({ json: { configured: false, enabled: false } }));
  await page.route("**/api/superuser/users**", (route) => route.fulfill({ json: users }));
}

test("lists the users of every cell and hands another cell's user to that cell", async ({ page }) => {
  await mockSuperuser(page, {
    currentCell: "eu",
    unavailableCells: [],
    users: [
      { ...ali, cell: us },
      { ...ana, cell: eu },
    ],
  });
  await page.route("https://us.superlog.sh/**", (route) =>
    route.fulfill({ body: "<p>US cell</p>", contentType: "text/html" }),
  );

  await page.goto("/superuser/users");
  await page.getByRole("button", { name: "Reject All" }).click();
  const table = page.getByRole("region", { name: "Responder users" });
  await expect(table.getByRole("row", { name: /Ali/u })).toContainText("United States");
  await expect(table.getByRole("row", { name: /Ana/u })).toContainText("Europe");
  await page.screenshot({ path: "test-results/user-support-cells.png" });

  await table.getByRole("row", { name: /Ali/u }).getByRole("button", { name: "View as user" }).click();

  await expect(page).toHaveURL(
    `https://us.superlog.sh/superuser/users?search=ali%40nautilus.co&view=${ali.id}`,
  );
});

test("asks to view as the user a link from another cell names", async ({ page }) => {
  const impersonated: unknown[] = [];
  await mockSuperuser(
    page,
    { currentCell: "us", unavailableCells: [], users: [{ ...ali, cell: us }] },
    (body) => impersonated.push(body),
  );
  const dialog = page.waitForEvent("dialog");

  await page.goto(`/superuser/users?search=ali%40nautilus.co&view=${ali.id}`);

  const prompt = await dialog;
  expect(prompt.message()).toContain("View Responder as Ali in United States?");
  await prompt.accept();
  await expect.poll(() => impersonated).toEqual([{ userId: ali.id }]);
});

test("says which cells could not be reached", async ({ page }) => {
  await mockSuperuser(page, {
    currentCell: "eu",
    unavailableCells: [us],
    users: [{ ...ana, cell: eu }],
  });

  await page.goto("/superuser/users");

  await expect(page.getByRole("alert")).toHaveText("Could not load users from United States.");
});
