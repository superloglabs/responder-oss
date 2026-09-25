import { expect, test } from "@playwright/test";

const automationId = "44444444-4444-4444-8444-444444444444";
const sentryAccountId = "22222222-2222-4222-8222-222222222222";
const datadogAccountId = "77777777-7777-4777-8777-777777777777";
const repositoryIds = ["11111111-1111-4111-8111-111111111111", "66666666-6666-4666-8666-666666666666"];

const automation = {
  configuration: {
    contextAccountIds: [datadogAccountId],
    harness: "claude_agent_sdk",
    maxModelRequests: 24,
    maxOutputTokensPerRequest: 16_000,
    maxRuntimeSeconds: 1_800,
    model: "claude-sonnet-4-6",
    modelCredentialId: null,
    modelProvider: "anthropic",
    prompt: "Investigate the reported issue and identify the root cause across the selected repositories.",
    repositoryIds,
    toolPolicy: "full",
    trigger: { eventTypes: ["new_issue"], integrationAccountId: sentryAccountId, kind: "sentry", projectIds: ["responder-web"] },
    workspaceSecretIds: [],
  },
  createdAt: "2026-09-01T10:00:00Z",
  description: "",
  enabled: true,
  id: automationId,
  inferenceSource: "responder",
  name: "Investigate production errors",
  runs: [],
  updatedAt: "2026-09-01T10:00:00Z",
  version: 3,
  versionId: "version",
};

function run(number: number, status: string, title: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  const created = new Date(Date.now() - minutesAgo * 60_000);
  return {
    completedAt: status === "running" ? null : new Date(created.getTime() + 272_000).toISOString(),
    createdAt: created.toISOString(),
    failureCategory: null,
    failureMessage: null,
    id: `run-${number}`,
    inferenceUsage: null,
    number,
    resultSummary: null,
    startedAt: new Date(created.getTime() + 2_000).toISOString(),
    status,
    trigger: { provider: "sentry", sourceUrl: `https://sentry.example/issues/${number}`, title },
    usage: null,
    ...extra,
  };
}

test.beforeEach(async ({ context }) => {
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const organization = { id: "org", name: "Acme", slug: "acme" };
    if (path.endsWith("/get-session")) return route.fulfill({ json: {
      session: { id: "session", userId: "user", activeOrganizationId: "org", expiresAt: "2099-01-01T00:00:00Z" },
      user: { id: "user", name: "Ada Lovelace", email: "ada@example.com", emailVerified: true },
    } });
    if (path.endsWith("/organization/list")) return route.fulfill({ json: [organization] });
    if (path.endsWith("/organization/get-full-organization")) return route.fulfill({ json: organization });
    if (path === "/api/context") return route.fulfill({ json: { capabilities: ["automations"] } });
    if (path === "/api/billing") return route.fulfill({ json: { configured: false, enabled: false } });
    if (path === "/api/automations/options") return route.fulfill({ json: {
      accounts: [
        { id: sentryAccountId, provider: "sentry", displayName: "Acme workspace" },
        { id: datadogAccountId, provider: "datadog", displayName: "Datadog" },
        { id: "github", provider: "github", displayName: "superloglabs" },
      ],
      resources: [{ id: "project", integrationAccountId: sentryAccountId, kind: "sentry_project", externalId: "responder-web", displayName: "responder-web" }],
      repositories: [{ id: repositoryIds[0], fullName: "superloglabs/responder" }, { id: repositoryIds[1], fullName: "superloglabs/responder-oss" }],
      credentials: [], secrets: [],
    } });
    if (path === `/api/automations/${automationId}`) return route.fulfill({ json: { automation } });
    if (path === `/api/automations/${automationId}/runs`) {
      const page = url.searchParams.get("page");
      const manual = { trigger: { provider: "manual", sourceUrl: null, title: "Manual run" } };
      // Twelve runs, ten per page.
      if (page === "1") return route.fulfill({ json: {
        page: 1, pageSize: 10, total: 12,
        runs: [
          run(12, "running", "RESP-2841: TypeError in checkout handler", 3),
          run(11, "succeeded", "RESP-2839: Payment webhook timeout", 30, { resultSummary: "Opened PR #248 with a regression test" }),
          run(10, "failed", "RESP-2828: Database connection refused", 26 * 60, { failureMessage: "Connector unavailable" }),
          ...Array.from({ length: 7 }, (_, index) => run(9 - index, "succeeded", "Manual run", 2 * 24 * 60 + index, manual)),
        ],
      } });
      if (page === "2") return route.fulfill({ json: { page: 2, pageSize: 10, total: 12, runs: [run(2, "succeeded", "Manual run", 3 * 24 * 60, manual), run(1, "succeeded", "Manual run", 4 * 24 * 60, manual)] } });
      return route.fulfill({ status: 400, json: { error: `Unexpected page ${page}` } });
    }
    if (path.startsWith("/api/automations/included-models/")) return route.fulfill({ json: { models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }] } });
    return route.fulfill({ json: {} });
  });
});

test("shows a saved automation and pages its run history", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/edit`);
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}$`));
  await expect(page.getByRole("heading", { name: "Investigate production errors" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("switch", { name: "Active" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue(automation.configuration.prompt);
  await expect(page.getByRole("button", { name: "Remove superloglabs/responder-oss" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Datadog" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("automation-detail-settings.png"), fullPage: true });

  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Run history" }).click();
  const table = page.getByRole("table");
  await expect(table.getByRole("link", { name: "RESP-2841: TypeError in checkout handler" })).toBeVisible();
  await expect(table.getByText("Run #12 · Sentry")).toBeVisible();
  await expect(table.getByText("Connector unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel run #12" })).toBeVisible();
  await expect(page.getByText("Showing 1–10 of 12 runs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("automation-detail-history.png"), fullPage: true });
  await page.getByRole("button", { name: "Next" }).click();
  await expect(table.getByText("Run #1 · Manual")).toBeVisible();
  await expect(page.getByText("Showing 11–12 of 12 runs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
});

test("saves each change to a saved automation immediately", async ({ page }) => {
  const saves: Array<Record<string, unknown>> = [];
  let failNext = false;
  await page.route(`**/api/automations/${automationId}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves.push(route.request().postDataJSON());
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 400, json: { error: "Choose a connected context integration" } });
    }
    await route.fulfill({ json: { updated: true } });
  });
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}`);
  const instructions = page.getByRole("textbox", { name: "Agent instructions" });
  await expect(instructions).toHaveValue(automation.configuration.prompt);

  await instructions.fill("Only investigate regressions.");
  expect(saves).toHaveLength(0);
  await instructions.blur();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ enabled: true, name: "Investigate production errors", configuration: { prompt: "Only investigate regressions.", repositoryIds } });
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await instructions.focus();
  await instructions.blur();
  await page.getByRole("button", { name: "Remove Datadog" }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toMatchObject({ configuration: { contextAccountIds: [], prompt: "Only investigate regressions." } });

  await page.getByRole("button", { name: "Remove superloglabs/responder", exact: true }).click();
  await expect.poll(() => saves.length).toBe(3);
  await page.getByRole("button", { name: "Remove superloglabs/responder-oss" }).click();
  await expect(page.getByText("Choose at least one repository. Changes save once the automation is complete.")).toBeVisible();
  expect(saves).toHaveLength(3);

  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await page.getByRole("option", { name: "superloglabs/responder", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => saves.length).toBe(4);
  expect(saves[3]).toMatchObject({ configuration: { repositoryIds: [repositoryIds[0]] } });
  await expect(page.getByText(/Changes save once/)).toHaveCount(0);

  failNext = true;
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await page.getByRole("option", { name: "superloglabs/responder-oss" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alert")).toHaveText("Choose a connected context integration");
  await expect(page.getByRole("button", { name: "Remove superloglabs/responder-oss" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove superloglabs/responder", exact: true })).toBeVisible();
});

test("reorders repositories and marks the first as the main directory", async ({ page }, testInfo) => {
  const saves: Array<{ configuration: { repositoryIds: string[] } }> = [];
  await page.route(`**/api/automations/${automationId}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves.push(route.request().postDataJSON());
    await route.fulfill({ json: { updated: true } });
  });
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}`);
  const rows = page.locator("section[aria-labelledby='automation-repositories'] .automationCreate__row");
  await expect(rows.nth(0)).toContainText("superloglabs/responderMain directory");
  await expect(rows.nth(1)).not.toContainText("Main directory");
  await page.locator("section[aria-labelledby='automation-repositories']").screenshot({ path: testInfo.outputPath("automation-repositories.png") });

  await page.getByRole("button", { name: /^Move superloglabs\/responder-oss/ }).press("ArrowUp");
  await expect.poll(() => saves.at(-1)?.configuration.repositoryIds).toEqual([repositoryIds[1], repositoryIds[0]]);
  await expect(rows.nth(0)).toContainText("superloglabs/responder-ossMain directory");
  await expect(page.getByRole("button", { name: /^Move superloglabs\/responder-oss/ })).toBeFocused();

  await page.getByRole("button", { name: /^Move superloglabs\/responder-oss/ }).dragTo(rows.nth(1));
  await expect.poll(() => saves.at(-1)?.configuration.repositoryIds).toEqual(repositoryIds);
  await expect(rows.nth(0)).toContainText("superloglabs/responderMain directory");
});

test("drops removed connections from a saved automation before saving it", async ({ page }) => {
  const stale = { ...automation, configuration: { ...automation.configuration, contextAccountIds: [datadogAccountId, "removed-account"], workspaceSecretIds: ["removed-secret"] } };
  let saved: Record<string, unknown> | undefined;
  await page.route(`**/api/automations/${automationId}`, async (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { updated: true } });
    }
    return route.fulfill({ json: { automation: stale } });
  });
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}`);
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Only investigate regressions.");
  await page.getByRole("textbox", { name: "Agent instructions" }).blur();
  await expect.poll(() => saved).toMatchObject({ configuration: { contextAccountIds: [datadogAccountId], workspaceSecretIds: [] } });
});

test("retries run history after a failed load", async ({ page }) => {
  let available = false;
  await page.route((url) => url.pathname === `/api/automations/${automationId}/runs`, async (route) => {
    if (available) return route.fallback();
    await route.fulfill({ status: 503, json: { error: "Run history is unavailable" } });
  });
  await page.goto(`/automations/${automationId}`);
  await page.getByRole("tab", { name: "Run history" }).click();
  await expect(page.getByRole("alert")).toContainText("Run history is unavailable");
  available = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Showing 1–10 of 12 runs")).toBeVisible();
});
