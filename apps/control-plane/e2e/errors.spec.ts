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

const issueId = "33333333-3333-4333-8333-333333333333";
const now = Date.now();
const issue = { id: issueId, title: "TypeError: Cannot read payment method", exceptionType: "TypeError", service: "checkout", kind: "span", status: "open", eventCount: 1284, firstSeenAt: new Date(now - 86400000).toISOString(), lastSeenAt: new Date(now - 60000).toISOString(), regressedAt: null, statusChangedAt: null, topFrame: "payment.ts:84", fingerprint: "v1:test", frames: ["payment.ts:84"], message: "Cannot read payment method", lastSample: { seenAt: new Date(now - 60000).toISOString(), kind: "span", message: "Cannot read payment method", stacktrace: "TypeError: Cannot read payment method\n    at processPayment (payment.ts:84:29)", traceId: "abc123", attributes: { "http.request.method": "POST" }, resourceAttributes: { "deployment.environment.name": "production", "service.version": "0123456789abcdef0123456789abcdef01234567-abcdef0123456789abcdef0123456789abcdef01" } } };

async function setup(page: Page, pageSize = 1) {
  await mockWorkspace(page, ["telemetry", "alerts", "simplified_navigation"]);
  await page.route("**/api/c15t/**", (route) => route.abort());
  await page.route("**/api/cells", (route) => route.fulfill({ json: { cells: [] } }));
  await page.route("**/api/telemetry/traces**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    return route.fulfill({ json: path.endsWith("/facets") ? { services: [{ group: "checkout", value: 3 }], statuses: [{ group: "STATUS_CODE_ERROR", value: 3 }], operations: [] } : { traces: Array.from({ length: url.searchParams.get("offset") === "50" ? 1 : 51 }, (_, index) => ({
      trace_id: `trace-${url.searchParams.get("offset") ?? "0"}-${index}`, start_time: new Date(now - 60_000).toISOString(), root_span_name: "POST /checkout", root_service: "checkout", service_count: 2, span_count: 8, duration_ms: 450, error_count: 1,
    })) } });
  });
  await page.route("**/api/telemetry/attribute-keys**", (route) => route.fulfill({ json: { keys: [] } }));
  const queries: URLSearchParams[] = [];
  let current = { ...issue };
  await page.route("**/api/error-issues**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(issueId)) {
      if (route.request().method() === "PATCH") current = { ...current, ...route.request().postDataJSON() };
      await route.fulfill({ json: { issue: current, days: [{ day: new Date().toISOString().slice(0, 10), eventCount: 32 }], hours: [{ hour: new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString(), eventCount: 32 }], since: new Date(now - 29 * 86400000).toISOString().slice(0, 10) } });
    } else {
      queries.push(url.searchParams);
      await route.fulfill({ json: { counts: { open: 1, resolved: 0, silenced: 0 }, services: ["checkout", "api"], environments: ["production", "staging"], since: new Date(now - 86400000).toISOString().slice(0, 10), issues: Array.from({ length: url.searchParams.has("before") ? 1 : pageSize }, (_, index) => ({ ...current, id: pageSize === 1 ? current.id : `33333333-3333-4333-8333-${String(index + (url.searchParams.has("before") ? 50 : 0)).padStart(12, "0")}`, days: [{ day: new Date().toISOString().slice(0, 10), eventCount: 32 }] })) } });
    }
  });
  return queries;
}

test("combines checkbox filters, removes chips, and preserves search in the URL", async ({ page }, testInfo) => {
  const queries = await setup(page);
  await page.goto("/errors");
  await page.getByRole("button", { name: "Reject All", exact: true }).click();
  await expect(page.getByRole("link", { name: issue.title })).toBeVisible();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: "Status", exact: true }).hover();
  await expect(page.getByRole("menuitemcheckbox", { name: "Resolved", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("errors-filter-checkboxes.png") });
  await page.getByRole("menuitemcheckbox", { name: "Resolved", exact: true }).click();
  await expect.poll(() => queries.at(-1)?.getAll("statuses")).toEqual(["open", "resolved"]);
  await expect(page.getByRole("menuitemcheckbox", { name: "Resolved", exact: true })).toBeChecked();
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Remove status filter" }).click();
  await expect.poll(() => queries.at(-1)?.get("status")).toBe("all");
  await expect.poll(() => queries.at(-1)?.getAll("statuses")).toEqual([]);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: "Activity", exact: true }).hover();
  await page.getByRole("menuitemcheckbox", { name: "No longer happening", exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get("activity")).toBe("inactive");
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: "Activity", exact: true }).press("ArrowRight");
  await page.getByRole("menuitemcheckbox", { name: "Still happening", exact: true }).click();
  await expect.poll(() => queries.at(-1)?.has("activity")).toBe(false);
  await expect(page.getByRole("menuitemcheckbox", { name: "Still happening", exact: true })).toBeChecked();
  await expect(page.getByRole("menuitemcheckbox", { name: "No longer happening", exact: true })).toBeChecked();
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await expect(page.locator(".errorFilterChip")).toContainText("No longer happening or Still happening");
  await page.getByRole("searchbox", { name: "Search errors" }).fill("payment");
  await expect.poll(() => queries.at(-1)?.get("search")).toBe("payment");
  await expect(page).toHaveURL(/q=payment/);
  await page.screenshot({ path: testInfo.outputPath("errors-catalog.png"), fullPage: true });
});

test("opens the detail and resolves an error", async ({ page }, testInfo) => {
  await setup(page); await page.goto("/errors");
  await page.getByRole("button", { name: "Reject All", exact: true }).click();
  await page.getByRole("link", { name: issue.title }).click();
  await expect(page.getByRole("heading", { name: issue.title })).toBeVisible();
  await expect(page.getByText("Still happening", { exact: true })).toHaveCount(0);
  await expect(page.locator(".errorIssue__properties")).toContainText("Unresolved");
  await expect(page.locator(".errorIssue__properties")).not.toContainText("Service version");
  await expect(page.getByRole("button", { name: "Span attributes 1" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("searchbox", { name: "Filter attribute keys" }).fill("http");
  await expect(page.getByText("http.request.method", { exact: true })).toBeVisible();
  await expect(page.locator(".explorerAttributes").getByText("deployment.environment.name", { exact: true })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Filter attribute keys" }).clear();
  await expect(page.getByText("production", { exact: true }).first()).toBeVisible();
  const related = page.getByRole("region", { name: "Related traces" });
  await expect(related.getByRole("columnheader")).toHaveText(["Started", "Root span", "Duration", "Spans", "Status"]);
  const href = await related.getByRole("link", { name: "Open in trace search" }).getAttribute("href");
  const params = new URL(href!, "http://localhost").searchParams;
  expect(params.get("service")).toBe("checkout");
  expect(params.get("status")).toBe("STATUS_CODE_ERROR");
  expect(params.get("filter")).toBe("resource.deployment.environment.name=production");
  await expect(page.getByText("32 events · Every 3 hours, last 30 days")).toBeVisible();
  await related.getByRole("button", { name: "Next", exact: true }).click();
  await expect(related.getByText("51–51 traces", { exact: true })).toBeVisible();
  await expect(related.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await related.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(related.getByText("1–50 traces", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("error-detail.png"), fullPage: true });
});

test("sorts the complete result set and applies bulk status actions", async ({ page }) => {
  const queries = await setup(page); await page.goto("/errors");
  await page.getByRole("button", { name: "Reject All", exact: true }).click();
  await expect(page.getByRole("link", { name: issue.title })).toBeVisible();
  await page.getByRole("button", { name: /Sort errors/ }).click();
  await page.getByRole("option", { name: "Sort: Events", exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get("sort")).toBe("events");
  await page.getByRole("checkbox", { name: "Select visible errors", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ignore", exact: true }).click();
  await expect(page.getByText("1 selected", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: issue.title }).click();
  await expect(page.getByText("Ignored", { exact: true })).toBeVisible();
});

test("supports a narrow viewport without overflowing the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page); await page.goto("/errors");
  await page.getByRole("button", { name: "Reject All", exact: true }).click();
  await expect(page.getByRole("link", { name: issue.title })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: issue.title }).click();
  await expect(page.locator(".errorIssue__properties")).not.toContainText("Service version");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("paginates with the active filters and resets when filters change", async ({ page }) => {
  const queries = await setup(page, 50); await page.goto("/errors?service=checkout");
  await page.getByRole("button", { name: "Reject All", exact: true }).click();
  await expect(page.getByText("1–50 errors", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("51–51 errors", { exact: true })).toBeVisible();
  expect(queries.at(-1)?.getAll("services")).toEqual(["checkout"]);
  expect(queries.at(-1)?.get("beforeId")).toBe("33333333-3333-4333-8333-000000000049");
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Remove service filter" }).click();
  await expect(page.getByText("1–50 errors", { exact: true })).toBeVisible();
  expect(queries.at(-1)?.has("before")).toBe(false);
});

test("configures Slack notifications from Errors", async ({ page }, testInfo) => {
  await setup(page);
  await page.route("**/api/auth/organization/get-active-member**", (route) => route.fulfill({ json: { id: "member", role: "admin", organizationId: organization.id, userId: "22222222-2222-4222-8222-222222222222" } }));
  const integrationAccountId = "44444444-4444-4444-8444-444444444444";
  let saved: unknown;
  await page.route("**/api/error-notifications", async (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON();
      await route.fulfill({ json: { settings: saved } });
    } else {
      await route.fulfill({ json: {
        settings: { enabled: false, targets: [] },
        channels: [{ integrationAccountId, channelId: "C123", name: "errors", accountName: "Acme", private: false }, ...Array.from({ length: 60 }, (_, i) => ({ integrationAccountId, channelId: `C${i}`, name: `team-${String(i).padStart(2, "0")}`, accountName: "Engineering", private: false }))],
      } });
    }
  });
  await page.goto("/errors");
  await page.getByRole("button", { name: "Reject All", exact: true }).click();
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Error notifications" });
  await expect(dialog).toBeVisible();
  await dialog.getByText("Enable error notifications", { exact: true }).click();
  await expect(dialog.getByRole("switch", { name: "Enable error notifications" })).toBeChecked();
  const search = dialog.getByRole("combobox", { name: "Search Slack channels" });
  const list = dialog.getByRole("listbox", { name: "Slack channels" });
  const body = dialog.locator(".dashboardDialog__body");
  const bodyScroll = await body.evaluate((node) => node.scrollTop);
  await list.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await body.evaluate((node) => node.scrollTop)).toBe(bodyScroll);
  await list.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.mouse.wheel(0, 700);
  expect(await body.evaluate((node) => node.scrollTop)).toBe(bodyScroll);
  await search.fill("no-such-channel");
  await expect(dialog.getByText("No channels found. Try another name or workspace.")).toBeVisible();
  await search.fill("engineering");
  await expect(dialog.getByRole("option")).toHaveCount(60);
  await search.fill("#errors");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(dialog.getByText("Sending to #errors")).toBeVisible();
  await search.fill("");
  await expect(dialog.getByRole("option")).toHaveCount(61);
  await list.evaluate((node) => { node.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath("error-notifications.png") });
  await page.setViewportSize({ width: 390, height: 640 });
  await expect(dialog.getByRole("button", { name: "Save notifications" })).toBeInViewport();
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("error-notifications-mobile.png") });
  await dialog.getByRole("button", { name: "Save notifications" }).click();
  await expect(dialog).not.toBeVisible();
  expect(saved).toEqual({ enabled: true, targets: [ { kind: "slack", integrationAccountId, channelId: "C123" }] });
  await page.route("**/api/error-notifications", (route) => route.fulfill({ json: { settings: { enabled: false, targets: [] }, channels: [] } }));
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(dialog.getByText("No Slack channels available")).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog.getByRole("switch").click();
  await expect(dialog.getByRole("button", { name: "Save notifications" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeFocused();
});
