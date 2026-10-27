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
  const results = page.locator(".explorerResults");
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
  await expect(page.locator(".explorerResults .dsDataTable")).toHaveCSS("overscroll-behavior", "none");
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


test("trace search shares grouped facets and keeps its window while filtering", async ({ page }, testInfo) => {
  await mockWorkspace(page, ["telemetry", "simplified_navigation"]);
  await page.route("**/api/c15t/**", (route) => route.abort());
  const queries: URLSearchParams[] = [];
  await page.route("**/api/telemetry/**", async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = { available: true };
    if (url.pathname.endsWith("/traces")) {
      queries.push(url.searchParams);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      json = { traces: Array.from({ length: offset >= 100 ? 12 : 51 }, (_, index) => {
        const i = offset + index;
        return ({
        trace_id: i.toString(16).padStart(32, "0"), root_span_name: `GET /orders/${i}`,
        root_service: "api", start_time: "2026-10-14T12:30:00Z", duration_ms: 600,
        span_count: 4, service_count: 2, error_count: 1,
      }); }) };
    } else if (url.pathname.endsWith("/histogram")) {
      json = { buckets: [{ bucket: "2026-10-14T12:30:00Z", count: 200, group: "STATUS_CODE_ERROR" }], since: "2026-10-14T12:00:00Z", until: "2026-10-14T13:00:00Z", stepMs: 60000 };
    } else if (url.pathname.endsWith("/facets")) {
      json = { services: [{ group: "api", value: 150 }, { group: "worker", value: 50 }], statuses: [{ group: "STATUS_CODE_ERROR", value: 200 }], operations: [{ group: "GET /orders", value: 200 }] };
    } else if (url.pathname.endsWith("/attribute")) {
      json = { values: [{ group: "production", value: 200 }] };
    } else if (url.pathname.includes("attribute-keys")) {
      json = { keys: ["resource.deployment.environment", ...Array.from({ length: 30 }, (_, i) => `span.key${i}`)].map((key) => ({ key })) };
    }
    await route.fulfill({ json });
  });
  await page.goto("/traces/search?from=2026-10-14T12:00:00.000Z&to=2026-10-14T13:00:00.000Z");
  const consent = page.getByRole("button", { name: "Reject All", exact: true });
  if (await consent.isVisible()) await consent.click();
  const filters = page.getByRole("complementary", { name: "Trace filters" });
  await expect(filters.getByText("150 · 75.0%")).toBeVisible();
  await expect(page.locator(".explorerResults tbody tr")).toHaveCount(50);
  await expect(page.locator(".traceRow__timestamp").first()).toHaveText(/2026-10-14 \d{2}:30:00\.000/);
  await expect(page.locator(".traceRow__status").first()).toHaveText("Error");
  await expect(page.locator(".traceRow__status").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const next = page.getByRole("button", { name: "Next", exact: true });
  const previous = page.getByRole("button", { name: "Previous", exact: true });
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(page.getByText("51–100 traces", { exact: true })).toBeVisible();
  await expect.poll(() => queries.at(-1)?.get("offset")).toBe("50");
  expect(queries.at(-1)?.get("until")).toBe(queries[0]?.get("until"));
  await next.click();
  await expect(page.getByText("101–112 traces", { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(page.getByText("51–100 traces", { exact: true })).toBeVisible();

  await filters.getByRole("checkbox", { name: /^worker/ }).click();
  await expect(filters.getByRole("checkbox", { name: /^worker/ })).toBeChecked();
  await expect.poll(() => queries.at(-1)?.getAll("service")).toEqual(["worker"]);
  await expect.poll(() => queries.at(-1)?.get("offset")).toBe("0");
  await expect(previous).toBeDisabled();
  expect(queries.at(-1)?.get("until")).toBe("2026-10-14T13:00:00.000Z");
  await filters.getByRole("checkbox", { name: /^Error/ }).click();
  await expect(filters.getByRole("checkbox", { name: /^Error/ })).toBeChecked();
  await expect.poll(() => queries.at(-1)?.getAll("status")).toEqual(["STATUS_CODE_ERROR"]);
  await filters.getByRole("checkbox", { name: /Over 500 ms/ }).click();
  await expect(filters.getByRole("checkbox", { name: /Over 500 ms/ })).toBeChecked();
  await expect.poll(() => queries.at(-1)?.get("minDurationMs")).toBe("500");
  await filters.getByRole("searchbox").fill("environment");
  const before = queries.length;
  await filters.getByRole("button", { name: "deployment.environment", exact: true }).click();
  await expect(filters.getByRole("checkbox", { name: /production/ })).toBeVisible();
  expect(queries.length).toBe(before);
  await filters.getByRole("checkbox", { name: /production/ }).click();
  await expect(filters.getByRole("checkbox", { name: /production/ })).toBeChecked();
  await expect.poll(() => queries.at(-1)?.getAll("filter")).toEqual(["resource.deployment.environment=production"]);
  await page.reload();
  await expect(filters.getByRole("checkbox", { name: /production/ })).toBeChecked();
  await expect(filters.getByRole("checkbox", { name: /^worker/ })).toBeChecked();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  expect(queries.at(-1)?.get("since")).toBe("2026-10-14T12:00:00.000Z");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator(".explorerResults .dsDataTable")).toHaveCSS("overflow-y", "auto");
  expect(await page.locator(".workspaceSurface").evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("trace-search.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(filters.getByRole("searchbox")).toBeVisible();
  expect(await page.locator(".explorerBody--search").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("search autocomplete shares URL state with facets and cancels chip edits", async ({ page }, testInfo) => {
  await mockWorkspace(page, ["telemetry", "simplified_navigation"]);
  await page.route("**/api/c15t/**", route => route.abort());
  await page.route("**/api/telemetry/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = { available: true };
    if (path.endsWith("/logs")) json = { logs: [] };
    else if (path.endsWith("/histogram")) json = { buckets: [], since: new Date(Date.now() - 3600000).toISOString(), until: new Date().toISOString(), stepMs: 60000 };
    else if (path.endsWith("/facets")) json = { services: [{ group: "api", value: 10 }, { group: "worker", value: 5 }], severities: [{ group: "ERROR", value: 5 }] };
    else if (path.endsWith("/attribute")) json = { values: [{ group: "eu-west-3", value: 10 }] };
    else if (path.endsWith("/attribute-keys")) json = { keys: [{ key: "resource.cloud.region" }, { key: "log.event" }] };
    await route.fulfill({ json });
  });
  await page.goto("/logs");
  const consent = page.getByRole("button", { name: "Reject All", exact: true });
  if (await consent.isVisible()) await consent.click();
  const search = page.getByRole("combobox", { name: "Search logs" });
  await search.fill("serv");
  await expect(page.getByRole("option", { name: "service.name", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("search-autocomplete.png") });
  await page.setViewportSize({ width: 320, height: 740 });
  const menu = page.locator(".telemetrySearch__popup");
  const bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("search-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await search.press("Enter");
  await expect(page.getByRole("option", { name: "api", exact: true })).toBeVisible();
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page).toHaveURL(/service=worker/);
  await expect(page.getByRole("complementary", { name: "Log filters" }).getByRole("checkbox", { name: /worker/ })).toBeChecked();
  await page.getByRole("button", { name: "Edit service.name = worker", exact: true }).click();
  await search.fill("api");
  await search.press("Escape");
  await expect(page).toHaveURL(/service=worker/);
  await page.getByRole("button", { name: "Edit service.name = worker", exact: true }).click();
  await search.fill("api");
  await search.press("Enter");
  await expect(page).toHaveURL(/service=api/);
  await expect(page).not.toHaveURL(/service=worker/);
  await search.fill("cloud");
  await page.getByRole("option", { name: "cloud.region", exact: true }).click();
  await expect(page.getByRole("option", { name: "eu-west-3", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change operator, is", exact: true }).click();
  await page.getByRole("option", { name: "!= is not", exact: true }).click();
  await page.getByRole("option", { name: "eu-west-3", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("filter")).toBe("resource.cloud.region!=eu-west-3");
  await search.fill("connection timed out");
  await search.press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("search")).toBe("connection timed out");
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has("filter")).toBe(false);
  await expect.poll(() => new URL(page.url()).searchParams.has("search")).toBe(false);
  await expect.poll(() => new URL(page.url()).searchParams.has("service")).toBe(false);
});

test("trace search commits minimum duration and ignores stale attribute suggestions", async ({ page }) => {
  await mockWorkspace(page, ["telemetry", "simplified_navigation"]);
  await page.route("**/api/c15t/**", route => route.abort());
  let releaseSlow!: () => void;
  const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
  await page.route("**/api/telemetry/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json: unknown = { available: true };
    if (path.endsWith("/traces")) json = { traces: [] };
    else if (path.endsWith("/histogram")) json = { buckets: [], since: new Date(Date.now() - 3600000).toISOString(), until: new Date().toISOString(), stepMs: 60000 };
    else if (path.endsWith("/facets")) json = { services: [], operations: [], statuses: [{ group: "STATUS_CODE_ERROR", value: 4 }] };
    else if (path.endsWith("/attribute-keys")) json = { keys: [{ key: "resource.cloud.region" }, { key: "span.http.route" }] };
    else if (path.endsWith("/attribute")) {
      if (url.searchParams.get("key") === "resource.cloud.region") { await slow; json = { values: [{ group: "old-region", value: 1 }] }; }
      else json = { values: [{ group: "/checkout", value: 1 }] };
    }
    await route.fulfill({ json });
  });
  await page.goto("/traces/search");
  const consent = page.getByRole("button", { name: "Reject All", exact: true });
  if (await consent.isVisible()) await consent.click();
  const search = page.getByRole("combobox", { name: "Filter traces" });
  await search.fill("duration>=500ms");
  await search.press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("minDurationMs")).toBe("500");
  await search.fill("status");
  await search.press("Enter");
  await page.getByRole("option", { name: "Error", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("status")).toBe("STATUS_CODE_ERROR");
  await search.fill("cloud");
  await page.getByRole("option", { name: "cloud.region", exact: true }).click();
  await expect(page.getByText("Loading values…", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change attribute", exact: true }).click();
  await search.fill("http.route");
  await page.getByRole("option", { name: "http.route", exact: true }).click();
  await expect(page.getByRole("option", { name: "/checkout", exact: true })).toBeVisible();
  releaseSlow();
  await expect(page.getByRole("option", { name: "old-region", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "/checkout", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("filter")).toBe("span.http.route=/checkout");
});
