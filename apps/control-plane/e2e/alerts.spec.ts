import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 1600 } });

const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme-workspace-id",
  createdAt: new Date().toISOString(),
  logo: null,
  metadata: null,
};

async function mockWorkspace(page: Page, capabilities: string[], contextDelayMs = 0) {
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
  await page.route("**/api/legacy-account-redirect", (route) => route.fulfill({ json: { redirect: false } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { integrations: [] } }));
  await page.route("**/api/automations", (route) => route.fulfill({ json: { automations: [] } }));
  await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: [] } }));
  await page.route("**/api/billing", (route) => route.fulfill({ json: { configured: false, enabled: false } }));
}

const alertId = "11111111-1111-4111-8111-111111111111";
const activationId = "33333333-3333-4333-8333-333333333333";
const now = Date.now();
const rule = {
  id: alertId,
  name: "High API error volume",
  aggregation: "count",
  comparator: "gt",
  field: null,
  source: "logs",
  filter: {
    service: "production-api",
    severity: "ERROR",
    resourceAttrs: [{ key: "environment", value: "production" }],
  },
  groupBy: null,
  groupMode: "single",
  metricName: null,
  threshold: 50,
  windowMinutes: 5,
  evaluationIntervalSeconds: 60,
  enabled: true,
  slack: null,
  lastError: null,
  createdAt: new Date(now - 86400000).toISOString(),
  updatedAt: new Date(now - 86400000).toISOString(),
  lastEvaluatedAt: new Date(now).toISOString(),
};
const episode = {
  id: activationId,
  groupKey: "",
  state: "resolved",
  endReason: "recovered",
  startedAt: new Date(now - 20 * 60000).toISOString(),
  endedAt: new Date(now - 17 * 60000).toISOString(),
  openValue: 61,
  peakValue: 76,
  lastValue: 34,
  ruleSnapshot: rule,
  slackChannelId: "C1",
  slackMessageTs: String((now - 20 * 60000) / 1000),
  recoveryNotifiedAt: new Date(now - 17 * 60000).toISOString(),
};
const chart = {
  buckets: Array.from({ length: 25 }, (_, index) => now - (24 - index) * 150000),
  stepMs: 150000,
  series: [
    {
      name: "All",
      values: [12, 16, 14, 21, 18, 20, 13, 17, 12, 25, 18, 22, 15, 19, 16, 23, 61, 76, 68, 65, 34, 22, 27, 19, 22],
    },
  ],
};

async function mockAlerts(page: Page, legacy = false) {
  await mockWorkspace(page, ["alerts", "telemetry", "simplified_navigation"]);
  await page.route("**/api/c15t/**", (route) => route.abort());
  await page.route("**/api/cells", (route) => route.fulfill({ json: { cells: [] } }));
  await page.addLocatorHandler(page.getByTestId("consent-banner-root"), async () => {
    await page.getByRole("button", { name: "Reject All", exact: true }).click();
  });
  let current = { ...rule };
  const writes: Array<Record<string, unknown>> = [];
  const previews: Array<Record<string, unknown>> = [];
  const historyQueries: string[] = [];
  await page.route("**/api/telemetry/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json: unknown;
    if (path.endsWith("/status")) json = { available: true };
    else if (path.endsWith("/services")) json = { services: ["production-api"] };
    else if (path.endsWith("/attribute-keys")) json = { keys: [{ key: "environment" }] };
    else if (path.endsWith("/slack-channels") || path.endsWith("/slack-channels/refresh")) json = { channels: [] };
    else if (path.endsWith("/preview")) {
      previews.push(route.request().postDataJSON());
      json = { chart, evaluations: [{ groupKey: "", value: 22, breaching: false }] };
    } else if (path.endsWith("/chart"))
      json = {
        chart: legacy ? null : chart,
        reason: legacy ? "The original rule was not recorded for this activation." : null,
      };
    else if (path.endsWith(`/activations/${activationId}`))
      json = {
        alert: current,
        activation: {
          ...episode,
          ...(legacy ? { ruleSnapshot: null, endReason: null, recoveryNotifiedAt: null } : {}),
        },
      };
    else if (path.endsWith("/highlights"))
      json = { highlights: [{ start: Date.parse(episode.startedAt), end: Date.parse(episode.endedAt), label: "Active alert" }] };
    else if (path.endsWith("/activations")) {
      historyQueries.push(url.search);
      json = { episodes: url.searchParams.get("state") === "firing" ? [] : [episode], hasMore: false };
    } else if (route.request().method() === "POST" || route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      writes.push(input);
      current = { ...current, ...input };
      json = { alert: current };
    } else if (path.endsWith(`/alerts/${alertId}`)) json = { alert: current, episodes: [episode], hasFiringActivations: false };
    else json = { alerts: [current] };
    await route.fulfill({ json });
  });
  return { writes, previews, historyQueries };
}

test("previews before naming or setting a threshold, creates enabled, and opens the overview", async ({ page }) => {
  const { writes, previews } = await mockAlerts(page);
  await page.goto("/alerts/new");
  await expect(page.getByRole("heading", { name: "1. Explore your data" })).toBeVisible();
  await expect.poll(() => previews.length).toBeGreaterThan(0);
  await expect(page.getByRole("img", { name: "Matching data over time" })).toBeVisible();
  await expect(page.getByRole("switch", { name: /enable|check this alert/i })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Alert name" }).fill("Checkout failures");
  await page.getByRole("textbox", { name: "Threshold", exact: true }).fill("50");
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Attribute Choose/ }).click();
  await dialog.getByRole("option", { name: "environment", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Value", exact: true }).fill("production");
  await dialog.getByRole("button", { name: "Apply filter" }).click();
  await expect(page.getByRole("button", { name: "environment is production" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Matching data over time" })).toBeVisible();
  await page.locator(".workspaceSurface").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: test.info().outputPath("creation.png"), fullPage: true });
  await page.getByRole("button", { name: "Create alert", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/alerts/${alertId}$`));
  expect(writes[0]).toMatchObject({
    enabled: true,
    threshold: 50,
    name: "Checkout failures",
    filter: { resourceAttrs: [{ key: "environment", value: "production" }] },
  });
  await expect(page.getByRole("heading", { name: "Activation history" })).toBeVisible();
});

test("filters activation history, opens a detail, and keeps original configuration", async ({ page }) => {
  const { historyQueries } = await mockAlerts(page);
  await page.goto(`/alerts/${alertId}`);
  await expect(page.getByRole("heading", { name: "Current evaluation" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Values and alert threshold" })).toBeVisible();
  await expect(page.getByText(/Loading activation shading/)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("alert-detail.png"), fullPage: true });
  await page.getByLabel("Activation state").selectOption("firing");
  await expect(page.getByText("No activations in this time range.")).toBeVisible();
  expect(historyQueries.at(-1)).toContain("state=firing");
  await page.getByLabel("Activation state").selectOption("all");
  await page.getByRole("link", { name: /#33333333/ }).click();
  await expect(page.getByRole("heading", { name: "Activation #33333333", exact: true })).toBeVisible();
  await expect(page.getByText("Configuration captured when this activation began.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Delivered", exact: true })).toHaveCount(2);
  await expect(page.getByRole("img", { name: "Values and alert threshold" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("activation-detail.png"), fullPage: true });
});

test("pauses and resumes through the overview and saves edits", async ({ page }) => {
  const { writes } = await mockAlerts(page);
  await page.goto(`/alerts/${alertId}`);
  await page.getByRole("button", { name: "Pause alert" }).click();
  await expect(page.getByRole("button", { name: "Resume alert" })).toBeVisible();
  expect(writes[0]?.enabled).toBe(false);
  await page.getByRole("button", { name: "Resume alert" }).click();
  await expect(page.getByRole("button", { name: "Pause alert" })).toBeVisible();
  await page.getByRole("button", { name: "Edit alert" }).click();
  await expect(page).toHaveURL(new RegExp(`/alerts/${alertId}/edit$`));
  await page.getByRole("textbox", { name: "Alert name" }).fill("Updated alert");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: "Updated alert", exact: true })).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ enabled: true, name: "Updated alert" });
});

test("older activations disclose unavailable history and fit a narrow screen", async ({ page }) => {
  await mockAlerts(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/alerts/${alertId}/activations/${activationId}`);
  await expect(page.getByText("The original configuration was not recorded for this activation.")).toBeVisible();
  await expect(page.getByText("A chart cannot be reconstructed without the original rule.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Not confirmed" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("activation-mobile.png"), fullPage: true });
});


test("health includes an older activation outside the displayed history", async ({ page }) => {
  await mockAlerts(page);
  await page.route(`**/api/telemetry/alerts/${alertId}`, (route) => route.fulfill({ json: {
    alert: rule, episodes: [episode], hasFiringActivations: true,
  } }));
  await page.goto(`/alerts/${alertId}`);
  await expect(page.locator(".alertProperties dl > div").filter({ hasText: "Health" }).locator("dd")).toHaveText("Firing");
});

test("keeps preview ranges at least as long as the evaluation window", async ({ page }) => {
  await mockAlerts(page);
  await page.goto(`/alerts/${alertId}/edit`);
  await page.getByRole("button", { name: /Over the last 5 minutes/ }).click();
  const request = page.waitForRequest((request) => request.url().includes("/preview?hours=6") && request.postDataJSON().windowMinutes === 360);
  await page.getByRole("option", { name: "6 hours", exact: true }).click();
  await request;
  await expect(page.getByRole("button", { name: "Preview time range Last 6 hours" })).toBeVisible();
  await page.getByRole("button", { name: "Preview time range Last 6 hours" }).click();
  await expect(page.getByRole("option", { name: "Last 1 hour", exact: true })).toHaveCount(0);
});
