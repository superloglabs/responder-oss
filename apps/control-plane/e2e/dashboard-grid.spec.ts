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

const dashboardId = "33333333-3333-4333-8333-333333333333";

const widgets = [
  { id: "44444444-4444-4444-8444-444444444441", layout: { h: 4, w: 6, x: 0, y: 0 }, title: "Runs by cell" },
  { id: "44444444-4444-4444-8444-444444444442", layout: { h: 4, w: 6, x: 6, y: 0 }, title: "Errors by event" },
].map((widget, position) => ({
  ...widget,
  config: { aggregation: "count", chartType: "bar", display: "timeseries", groupBy: "cell", source: "traces" },
  position,
  type: "timeseries_count",
}));

async function mockDashboardApis(page: Page) {
  await page.route("**/api/**", async (route) => {
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
    if (path === `/api/telemetry/dashboards/${dashboardId}`) {
      await route.fulfill({
        json: { dashboard: { id: dashboardId, name: "Automation runs", updatedAt: new Date().toISOString(), variables: [], widgets } },
      });
      return;
    }
    if (path === "/api/telemetry/widget-data") {
      const stepMs = 60_000;
      const buckets = Array.from({ length: 120 }, (_, index) => Date.now() - (120 - index) * stepMs);
      await route.fulfill({
        json: {
          chart: {
            buckets,
            series: ["eu", "us"].map((name) => ({ name, values: buckets.map((_, index) => (index % 7) + 1) })),
            stepMs,
          },
          kind: "chart",
        },
      });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

// Each change to a chart's width redraws the whole chart.
async function watchChartWidths(page: Page) {
  await page.addInitScript(() => {
    const changes = { count: 0 };
    Object.assign(window, { chartWidthChanges: changes });
    new MutationObserver((records) => {
      for (const record of records) if (record.target instanceof SVGSVGElement) changes.count += 1;
    }).observe(document, { attributeFilter: ["width"], attributes: true, subtree: true });
  });
}

function chartWidthChanges(page: Page) {
  return page.evaluate(() => (window as unknown as { chartWidthChanges: { count: number } }).chartWidthChanges.count);
}

test("dashboard charts draw once at their width on load and on resize", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockDashboardApis(page);
  await watchChartWidths(page);

  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.locator(".timeseriesChart svg")).toHaveCount(2);
  await page.waitForTimeout(500);
  expect(await chartWidthChanges(page)).toBe(0);

  await page.evaluate(() => {
    (window as unknown as { chartWidthChanges: { count: number } }).chartWidthChanges.count = 0;
  });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(500);
  expect(await chartWidthChanges(page)).toBe(2);
});
