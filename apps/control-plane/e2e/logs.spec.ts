import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 1000 } });

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

test("groups facets, filters values, scrolls, and paginates a fixed window", async ({
  page,
}, testInfo) => {
  await mockWorkspace(page, ["telemetry", "simplified_navigation"]);
  await page.route("**/api/c15t/**", (route) => route.abort());
  const queries: URLSearchParams[] = [];
  let responseGate: Promise<void> | null = null;
  await page.route("**/api/telemetry/**", async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = { available: true };
    if (url.pathname.endsWith("/logs")) {
      queries.push(url.searchParams);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      json = {
        logs: Array.from({ length: 100 }, (_, i) => ({
          timestamp: new Date(Date.now() - (offset + i) * 1000).toISOString(),
          severity: "INFO",
          service: "responder-control-plane",
          body: `Log message ${offset + i}`,
          trace_id: "",
          span_id: "",
          log_attrs: {},
          resource_attrs: {},
        })),
      };
    } else if (url.pathname.endsWith("/histogram")) {
      json = {
        buckets: [
          { bucket: new Date().toISOString(), count: 430, group: "INFO" },
        ],
        since: new Date(Date.now() - 3600000).toISOString(),
        until: new Date().toISOString(),
        stepMs: 60000,
      };
    } else if (url.pathname.endsWith("/facets")) {
      json = {
        services: [
          { group: "responder-control-plane", value: 405 },
          { group: "responder-worker", value: 25 },
        ],
        severities: [
          { group: "ERROR", value: 143 },
          { group: "WARN", value: 1 },
          { group: "INFO", value: 286 },
        ],
      };
    } else if (url.pathname.endsWith("/attribute"))
      json = { values: [{ group: "us-east-1", value: 430 }] };
    else if (url.pathname.includes("attribute-keys"))
      json = {
        keys: [
          "resource.cloud.region",
          "resource.deployment.environment.name",
          "resource.host.name",
          "resource.responder.cell",
          "resource.service.version",
          ...Array.from({ length: 30 }, (_, i) => `log.key${i}`),
        ].map((key) => ({ key })),
      };
    await responseGate;
    await route.fulfill({ json });
  });
  await page.goto("/logs");
  const consent = page.getByRole("button", { name: "Reject All", exact: true });
  if (await consent.isVisible()) await consent.click();
  const filters = page.getByRole("complementary", { name: "Log filters" });
  await expect(filters.getByText("405 · 94.2%")).toBeVisible();
  await expect(
    filters.getByRole("button", { name: "Service", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await filters.getByRole("button", { name: "Service", exact: true }).click();
  await expect(filters.getByText("405 · 94.2%")).toHaveCount(0);
  await filters.getByRole("button", { name: "Service", exact: true }).click();
  const results = page.locator(".logResults");
  await expect(results).toHaveAttribute("aria-busy", "false");
  const before = await results.boundingBox();
  let release!: () => void;
  responseGate = new Promise<void>((resolve) => { release = resolve; });
  await filters.getByText("responder-worker", { exact: true }).click();
  await expect(results).toHaveAttribute("aria-busy", "true");
  await expect(results.locator("tbody tr")).toHaveCount(100);
  await expect(filters.getByText("405 · 94.2%")).toBeVisible();
  expect(await results.boundingBox()).toEqual(before);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  release();
  responseGate = null;
  await expect(results).toHaveAttribute("aria-busy", "false");
  expect(await results.boundingBox()).toEqual(before);
  await expect
    .poll(() => queries.at(-1)?.getAll("service"))
    .toEqual(["responder-worker"]);
  await expect(
    filters.getByRole("checkbox", { name: /responder-worker/ }),
  ).toBeChecked();
  await filters.getByRole("checkbox", { name: /responder-worker/ }).focus();
  await page.keyboard.press("Space");
  await expect(
    filters.getByRole("checkbox", { name: /responder-worker/ }),
  ).not.toBeChecked();
  await expect.poll(() => queries.at(-1)?.getAll("service")).toEqual([]);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get("offset")).toBe("100");
  await expect(
    page.getByText("Log message 100", { exact: true }),
  ).toBeVisible();
  expect(queries.at(-1)?.get("until")).toBe(queries[0]?.get("until"));
  await filters.getByText("responder-worker", { exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get("offset")).toBe("0");
  await filters.getByRole("searchbox").fill("cloud");
  await expect(
    filters.getByRole("button", { name: "cloud.region", exact: true }),
  ).toBeVisible();
  await filters
    .getByRole("button", { name: "cloud.region", exact: true })
    .click();
  await expect(
    filters.getByRole("checkbox", { name: /us-east-1/ }),
  ).toBeVisible();
  await filters.getByRole("searchbox").fill("");
  await expect(page.locator(".logFacets__shadow")).toHaveCount(0);
  await page.locator(".logFacets__viewport").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.locator(".logFacets__shadow")).toHaveCount(0);
  await page.locator(".logFacets__viewport").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeInViewport();
  expect(await page.locator(".workspaceSurface").evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
  await expect(page.locator(".logResults .dsDataTable")).toHaveCSS("overscroll-behavior", "none");
  await page.screenshot({ path: testInfo.outputPath("log-facets.png") });
});

test("log drawer fills the viewport and groups attributes without losing search or actions", async ({ page, context }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockWorkspace(page, ["telemetry", "simplified_navigation"]);
  await page.route("**/api/c15t/**", (route) => route.abort());
  await page.route("**/api/telemetry/**", async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = { available: true };
    if (url.pathname.endsWith("/logs")) {
      json = { logs: [0, 1].map((index) => ({
        timestamp: `2026-10-26T17:56:3${index}.551Z`,
        severity: "ERROR",
        service: "responder-control-plane",
        body: `scheduled_scan_failed ${index}`,
        trace_id: "",
        span_id: "span-123",
        log_attrs: { error: "Agent is missing an active configuration", event: "scheduled_scan_failed" },
        resource_attrs: { "cloud.region": "eu-west-3", "service.name": "responder-control-plane" },
      })) };
    } else if (url.pathname.endsWith("/histogram")) {
      json = { buckets: [], since: "2026-10-26T17:00:00Z", until: "2026-10-26T18:00:00Z", stepMs: 60000 };
    } else if (url.pathname.endsWith("/facets")) {
      json = { services: [], severities: [] };
    } else if (url.pathname.includes("attribute-keys")) json = { keys: [] };
    await route.fulfill({ json });
  });
  await page.goto("/logs");
  const consent = page.getByRole("button", { name: "Reject All", exact: true });
  if (await consent.isVisible()) await consent.click();
  await page.getByText("scheduled_scan_failed 0", { exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "Log details" });
  await expect(drawer).toBeVisible();
  const rect = await drawer.boundingBox();
  expect(rect).toMatchObject({ y: 0, width: 600, height: 1000 });
  expect(rect!.x + rect!.width).toBe(1440);
  await expect(drawer.getByRole("group", { name: "Attribute scope" })).toHaveCount(0);
  await expect(drawer.getByText("Attributes 5", { exact: true })).toBeVisible();
  await expect(drawer.getByText("span-123", { exact: true })).toBeVisible();
  const logGroup = drawer.getByRole("button", { name: "Log attributes 2" });
  const resourceGroup = drawer.getByRole("button", { name: "Resource attributes 2" });
  await expect(logGroup).toHaveAttribute("aria-expanded", "true");
  await expect(resourceGroup).toHaveAttribute("aria-expanded", "false");
  await expect(drawer.getByText("eu-west-3", { exact: true })).toBeHidden();
  await resourceGroup.focus();
  await page.keyboard.press("Enter");
  await expect(drawer.getByText("eu-west-3", { exact: true })).toBeVisible();
  await resourceGroup.click();
  await logGroup.click();
  await expect(drawer.getByText("Agent is missing an active configuration", { exact: true })).toBeHidden();
  const search = drawer.getByRole("searchbox", { name: "Filter attribute keys" });
  await search.fill("CLOUD");
  await expect(drawer.getByText("eu-west-3", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Resource attributes 1" })).toHaveAttribute("aria-expanded", "true");
  await search.fill("no-such-key");
  await expect(drawer.getByText("No attributes match.")).toBeVisible();
  await search.fill("");
  const resourceRow = drawer.locator(".explorerAttributes__row").filter({ has: page.getByText("cloud.region", { exact: true }) });
  await resourceRow.hover();
  await resourceRow.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("eu-west-3");
  await expect(drawer.getByRole("button", { name: "Previous log" })).toBeDisabled();
  const next = drawer.getByRole("button", { name: "Next log" });
  await expect(next).toHaveCSS("height", "26px");
  await expect(next).toHaveCSS("width", "30px");
  await expect(next).toHaveCSS("border-radius", "6px");
  const timestampColor = await drawer.locator("time").evaluate((node) => getComputedStyle(node).color);
  await expect(drawer.locator(".logDrawer__service")).toHaveCSS("color", timestampColor);
  await next.click();
  await expect(drawer.getByText("scheduled_scan_failed 1", { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  await expect(resourceGroup).toHaveAttribute("aria-expanded", "true");
  await resourceGroup.click();
  await page.screenshot({ path: testInfo.outputPath("log-drawer-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer).toBeVisible();
  expect(await drawer.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  await expect(drawer.getByRole("button", { name: "Close log details" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("log-drawer-mobile.png") });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByText("scheduled_scan_failed 0", { exact: true }).click();
  await drawer.getByRole("button", { name: "Resource attributes 2" }).click();
  await resourceRow.hover();
  await resourceRow.getByRole("button", { name: "Filter", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.getAll("filter").join(" ")).toContain("resource.cloud.region");
});
