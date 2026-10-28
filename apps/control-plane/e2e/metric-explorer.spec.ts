import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1728, height: 1000 } });

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
  await page.route("**/api/integrations", (route) =>
    route.fulfill({ json: { integrations: [] } }),
  );
  await page.route("**/api/automations", (route) =>
    route.fulfill({ json: { automations: [] } }),
  );
  await page.route("**/api/agents", (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route("**/api/billing", (route) =>
    route.fulfill({ json: { configured: false, enabled: false } }),
  );
}

const metricName = "v8js.memory.heap.space.physical_size";
const metric = (name: string) => ({ name, kind: "gauge", unit: "By", points: 120, attributes: ["space"], description: "Committed size of a heap space.", series: 1, services: ["api", "worker", "ingest"], servicesComplete: true });

async function setup(page: Page) {
  await mockWorkspace(page, ["telemetry", "simplified_navigation", "alerts", "dashboards"]);
  await page.route("**/api/c15t/**", route => route.abort());
  const requests: Array<{ filters: unknown[]; groupBy?: string; aggregation?: string }> = [];
  await page.route("**/api/telemetry/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = { available: true };
    if (path.endsWith("/metric-catalog")) json = { metrics: [
      ...Array.from({ length: 34 }, (_, i) => metric(`group_${i}.value`)),
      metric(metricName), metric("v8js.memory.heap.used"),
    ] };
    if (path.endsWith("/metric-dimensions")) json = { dimensions: [
      { key: "resource.service.name", name: "service.name", scope: "resource", cardinality: 3, values: [{ value: "api", share: 0.6 }, { value: "worker", share: 0.4 }] },
      { key: "attr:space", name: "space", scope: "point", cardinality: 2, values: [{ value: "old", share: 0.5 }, { value: "new", share: 0.5 }] },
    ] };
    if (path.endsWith("/metric-series")) {
      requests.push(route.request().postDataJSON());
      json = { chart: { buckets: Array.from({ length: 20 }, (_, i) => Date.now() - (20 - i) * 30000), stepMs: 30000, series: [{ name: "(none)", values: Array.from({ length: 20 }, (_, i) => 30000000 + i % 5 * 5000000) }] } };
    }
    await route.fulfill({ json });
  });
  await page.goto(`/metrics/explore?metric=${metricName}&kind=gauge&unit=By`);
  const consent = page.getByRole("button", { name: "Reject All", exact: true });
  if (await consent.isVisible()) await consent.click();
  await expect(page.getByRole("heading", { name: metricName, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "All services", exact: true })).toBeVisible();
  return requests;
}

test("filters and groups metrics with shared search, preserves state, and switches charts by keyboard", async ({ page }, testInfo) => {
  const requests = await setup(page);
  const browser = page.getByRole("navigation", { name: "Metrics", exact: true });
  await expect(browser.locator('[aria-current="page"]')).toBeInViewport();
  await expect(browser.getByRole("button")).toHaveCount(35);
  await expect(browser.getByRole("button").first()).toHaveText("v8js2");
  await page.screenshot({ path: testInfo.outputPath("metric-explorer-initial.png"), fullPage: true });
  await expect(page.getByRole("complementary", { name: "Dimensions" })).toHaveCount(0);
  const search = page.getByRole("combobox", { name: "Filter metrics" });
  await search.click();
  await page.getByRole("option", { name: "service.name", exact: true }).click();
  await page.getByRole("option", { name: "api", exact: true }).click();
  await expect.poll(() => requests.at(-1)?.filters).toEqual([{ key: "resource.service.name", value: "api" }]);
  await search.fill("attr:space!=old");
  await search.press("Enter");
  await expect.poll(() => requests.at(-1)?.filters).toContainEqual({ key: "attr:space", op: "neq", value: "old" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit space != old", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Group by No grouping", exact: true }).click();
  await page.getByRole("option", { name: /space/ }).click();
  await expect.poll(() => requests.at(-1)?.groupBy).toBe("attr:space");
  await page.getByRole("radio", { name: "Lines", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Bars", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "Bars", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect.poll(() => requests.at(-1)?.filters).toEqual([]);
  await expect.poll(() => requests.at(-1)?.groupBy).toBe("attr:space");
  await page.screenshot({ path: testInfo.outputPath("metric-explorer.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(search).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
