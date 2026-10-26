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
