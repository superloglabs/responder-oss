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

const traceId = "a".repeat(32);
const secondId = "b".repeat(32);
const start = "1793200000000000000";
const spans = Array.from({ length: 12 }, (_, index) => ({
  span_id: String(index).padStart(16, "0"), parent_span_id: index ? "0".repeat(16) : "",
  trace_id: traceId, span_name: index ? `database query ${index}` : "GET /api/orders",
  service: index ? "orders-database" : "api", span_kind: index ? "SPAN_KIND_CLIENT" : "SPAN_KIND_SERVER",
  timestamp: new Date().toISOString(), start_ns: String(BigInt(start) + BigInt(index * 20_000_000)),
  duration_ms: index ? 80 : 400, status_code: "STATUS_CODE_OK", status_message: "",
  exception_message: "", exception_type: "", exception_stacktrace: "",
  span_attrs: index ? { "db.operation.name": "SELECT" } : { "http.request.method": "GET", "http.route": "/api/orders", "http.response.status_code": "200", "request.id": "request-123" },
  resource_attrs: { "service.name": index ? "orders-database" : "api" },
}));

async function setup(page: Page) {
  await mockWorkspace(page, ["telemetry", "simplified_navigation"]);
  await page.route("**/api/c15t/**", (route) => route.abort());
  await page.route("**/api/telemetry/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = { available: true };
    if (path.endsWith(`/traces/${traceId}`) || path.endsWith(`/traces/${secondId}`)) json = { spans, logs: [] };
    else if (path.endsWith("/traces")) json = { traces: [traceId, secondId].map((id) => ({ trace_id: id, root_service: "api", root_span_name: "GET /api/orders", root_status_code: "STATUS_CODE_OK", span_count: 12, service_count: 2, error_count: 0, duration_ms: 400, start_time: new Date().toISOString() })) };
    else if (path.endsWith("/histogram")) json = { buckets: [], since: new Date(Date.now() - 3600000).toISOString(), until: new Date().toISOString(), stepMs: 60000 };
    else if (path.endsWith("/facets")) json = { services: [], statuses: [] };
    else if (path.includes("attribute-keys")) json = { keys: [] };
    return route.fulfill({ json });
  });
  await page.goto(`/traces/search?trace=${traceId}`);
}

test("inspects, searches and collapses spans without losing trace context", async ({ page }, testInfo) => {
  await setup(page);
  const drawer = page.getByRole("complementary", { name: "Trace details", exact: true });
  const panel = page.getByRole("region", { name: "Span details" });
  await expect(panel.getByRole("heading", { name: "GET /api/orders" })).toBeVisible();
  await expect(drawer.locator(".traceWaterfall__row")).toHaveCount(12);
  await page.screenshot({ path: testInfo.outputPath("trace-desktop.png") });
  const tabs = await drawer.locator(".traceDrawer__tabs").boundingBox();
  const inspector = await panel.boundingBox();
  expect(Math.abs(inspector!.y - (tabs!.y + tabs!.height))).toBeLessThan(1);
  await drawer.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(drawer.locator(".traceWaterfall__row")).toHaveCount(1);
  const search = drawer.getByRole("searchbox", { name: "Find a span or attribute" });
  await search.fill("database query 7");
  await expect(drawer.locator(".traceWaterfall__row")).toHaveCount(2);
  await drawer.getByRole("button", { name: "Inspect database query 7, 80 ms", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "database query 7" })).toBeVisible();
  await panel.getByRole("button", { name: "Close span details" }).click();
  await expect(panel).toHaveCount(0);
  await search.fill("");
  await drawer.getByRole("button", { name: "Expand all", exact: true }).first().click();
  await expect(drawer.locator(".traceWaterfall__row")).toHaveCount(12);
  await drawer.getByRole("button", { name: "Inspect GET /api/orders, 400 ms", exact: true }).click();
  await expect(panel.getByRole("button", { name: "HTTP 3", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByRole("button", { name: "Request context 1", exact: true })).toHaveAttribute("aria-expanded", "false");
  await panel.getByRole("searchbox", { name: "Filter attribute keys" }).fill("request.id");
  await expect(panel.getByText("request-123", { exact: true })).toBeVisible();
  await panel.getByText("request-123", { exact: true }).hover();
  await panel.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(/span.request.id/);
});

test("navigates traces and fits a narrow viewport", async ({ page }, testInfo) => {
  await setup(page);
  const drawer = page.getByRole("complementary", { name: "Trace details", exact: true });
  await expect(drawer.getByRole("button", { name: "Previous trace" })).toBeDisabled();
  await drawer.getByRole("button", { name: "Next trace" }).click();
  await expect(page).toHaveURL(new RegExp(secondId));
  await drawer.getByRole("button", { name: "Previous trace" }).click();
  await expect(page).toHaveURL(new RegExp(traceId));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer.getByRole("heading", { name: "/api/orders", exact: true })).toBeVisible();
  expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("trace-mobile.png") });
});
