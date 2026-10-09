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
    modelProvider: "anthropic",
    prompt: "Investigate the reported issue and identify the root cause across the selected repositories.",
    repositoryIds,
    toolPolicy: "full",
    triggers: [{ eventTypes: ["new_issue"], integrationAccountId: sentryAccountId, kind: "sentry", projectIds: ["responder-web"] }],
    skillIds: [],
    workspaceSecretIds: [],
  },
  createdAt: "2026-09-01T10:00:00Z",
  description: "",
  enabled: true,
  id: automationId,
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
    if (/^\/api\/automations\/sentry\/[^/]+\/environments$/.test(path)) return route.fulfill({ json: { environments: ["production"] } });
    if (path === "/api/automations/options") return route.fulfill({ json: {
      accounts: [
        { id: sentryAccountId, provider: "sentry", displayName: "Acme workspace" },
        { id: datadogAccountId, provider: "datadog", displayName: "Datadog" },
        { id: "github", provider: "github", displayName: "superloglabs" },
      ],
      resources: [{ id: "project", integrationAccountId: sentryAccountId, kind: "sentry_project", externalId: "responder-web", displayName: "responder-web" }],
      repositories: [{ id: repositoryIds[0], fullName: "superloglabs/responder" }, { id: repositoryIds[1], fullName: "superloglabs/responder-oss" }],
      credentials: [], secrets: [], skills: [],
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
    if (path === `/api/automations/${automationId}/usage`) return route.fulfill({ json: {
      days: ["2026-10-08", "2026-10-09"],
      // Totals follow the range so a range change shows in both cards.
      points: [{ aiCharge: Number(url.searchParams.get("days")) / 10, day: "2026-10-09", machineHours: Number(url.searchParams.get("days")) / 24, source: automationId }],
      sources: { [automationId]: { automationId, kind: "automation", name: "Investigate production errors" } },
    } });
    if (path.startsWith("/api/automations/included-models/")) return route.fulfill({ json: { models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }] } });
    return route.fulfill({ json: {} });
  });
});

test("shows a saved automation and pages its run history", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/edit`);
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}/settings$`));
  await expect(page.getByRole("heading", { name: "Investigate production errors" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveText(["Run history", "Usage", "Settings"]);
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("switch", { name: "Active" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue(automation.configuration.prompt);
  await expect(page.getByRole("button", { name: "Remove superloglabs/responder-oss" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Datadog" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("automation-detail-settings.png"), fullPage: true });

  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Run history" }).click();
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}$`));
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

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}/settings$`));
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue(automation.configuration.prompt);
});

test("shows an automation's machine hours and AI usage on its own tab", async ({ page }) => {
  await page.goto(`/automations/${automationId}`);
  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}/usage$`));
  await expect(page.getByRole("tab", { name: "Usage" })).toHaveAttribute("aria-selected", "true");

  const hours = page.locator(".usageCard").filter({ has: page.getByRole("heading", { name: "Machine hours" }) });
  const ai = page.locator(".usageCard").filter({ has: page.getByRole("heading", { name: "AI usage" }) });
  await expect(hours.locator(".usageCard__header strong")).toHaveText("1.3 h");
  await expect(ai.locator(".usageCard__header strong")).toHaveText("$3.00");

  await page.getByRole("radio", { name: "7 days" }).click();
  await expect(hours.locator(".usageCard__header strong")).toHaveText("0.3 h");
  await expect(ai.locator(".usageCard__header strong")).toHaveText("$0.70");

  // The range moves with the arrow keys from the selected option.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "30 days" })).toBeFocused();
  await expect(hours.locator(".usageCard__header strong")).toHaveText("1.3 h");
  await expect(page.locator(".usageChart__legend")).toHaveCount(0);
});

test("opens a saved automation on its run history", async ({ page }) => {
  await page.goto(`/automations/${automationId}`);
  await expect(page.getByRole("tab", { name: "Run history" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Showing 1–10 of 12 runs")).toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}/settings$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}$`));
  await expect(page.getByRole("tab", { name: "Run history" })).toHaveAttribute("aria-selected", "true");
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
  await page.goto(`/automations/${automationId}/settings`);
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
  await expect.poll(() => saves.length).toBe(4);
  expect(saves[3]).toMatchObject({ configuration: { repositoryIds: [] } });
  await expect(page.getByText(/Changes save once/)).toHaveCount(0);

  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await page.getByRole("option", { name: "superloglabs/responder", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => saves.length).toBe(5);
  expect(saves[4]).toMatchObject({ configuration: { repositoryIds: [repositoryIds[0]] } });

  failNext = true;
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await page.getByRole("option", { name: "superloglabs/responder-oss" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alert")).toHaveText("Choose a connected context integration");
  await expect(page.getByRole("button", { name: "Remove superloglabs/responder-oss" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove superloglabs/responder", exact: true })).toBeVisible();
});

test("restores a Slack trigger's ignored phrases when saving them fails", async ({ page }) => {
  const slackAccountId = "88888888-8888-4888-8888-888888888888";
  const saved = { ...automation, configuration: { ...automation.configuration, triggers: [{ channelIds: ["C123"], eventMode: "every_message", ignoredPhrases: ["^Resolved:"], integrationAccountId: slackAccountId, kind: "slack" }] } };
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: [
      { id: slackAccountId, provider: "slack", displayName: "Engineering" },
      { id: datadogAccountId, provider: "datadog", displayName: "Datadog" },
      { id: "github", provider: "github", displayName: "superloglabs" },
    ],
    resources: [{ id: "channel", integrationAccountId: slackAccountId, kind: "slack_channel", externalId: "C123", displayName: "#alerts" }],
    repositories: [{ id: repositoryIds[0], fullName: "superloglabs/responder" }, { id: repositoryIds[1], fullName: "superloglabs/responder-oss" }],
    credentials: [], secrets: [], skills: [],
  } }));
  const saves: Array<{ configuration: { triggers: Array<{ ignoredPhrases?: string[] }> } }> = [];
  await page.route(`**/api/automations/${automationId}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: { automation: saved } });
    saves.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: "Please try again" } });
  });
  await page.goto(`/automations/${automationId}/settings`);
  const phrases = page.getByRole("textbox", { name: "Ignore messages matching", exact: true });
  await expect(phrases).toHaveValue("^Resolved:");

  // Typing saves nothing until the field loses focus.
  await phrases.fill("^Resolved:\ndeploy");
  expect(saves).toHaveLength(0);
  await phrases.blur();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].configuration.triggers[0].ignoredPhrases).toEqual(["^Resolved:", "deploy"]);
  await expect(page.getByRole("alert")).toHaveText("Please try again");
  await expect(phrases).toHaveValue("^Resolved:");
});

test("reorders repositories and marks the first as the main directory", async ({ page }, testInfo) => {
  const saves: Array<{ configuration: { repositoryIds: string[] } }> = [];
  await page.route(`**/api/automations/${automationId}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves.push(route.request().postDataJSON());
    await route.fulfill({ json: { updated: true } });
  });
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/settings`);
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
  await page.goto(`/automations/${automationId}/settings`);
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
  await expect(page.getByRole("alert")).toContainText("Run history is unavailable");
  available = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Showing 1–10 of 12 runs")).toBeVisible();
});

test("runs a scheduled automation from Settings and opens the run", async ({ page }, testInfo) => {
  const scheduled = {
    ...automation,
    configuration: {
      ...automation.configuration,
      triggers: [{ frequency: "daily", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 }],
    },
    name: "Morning error digest",
  };
  const started: string[] = [];
  await page.route(`**/api/automations/${automationId}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ json: { automation: scheduled } });
  });
  await page.route(`**/api/automations/${automationId}/runs`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started.push(route.request().url());
    await route.fulfill({ status: 202, json: { duplicate: false, jobId: "job", runId: "run-13" } });
  });
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/settings`);
  await expect(page.getByRole("heading", { name: "Morning error digest" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: testInfo.outputPath("automation-detail-scheduled.png") });

  await page.getByRole("button", { name: "Run now" }).click();

  await expect.poll(() => started.length).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}/runs/run-13$`));
});

test("keeps Run now in the history of an event-triggered automation", async ({ page }) => {
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/settings`);
  await expect(page.getByRole("heading", { name: "Investigate production errors" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Run history" }).click();
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
});

test("adds a Slack notification to a scheduled automation", async ({ page }, testInfo) => {
  const slackAccountId = "88888888-8888-4888-8888-888888888888";
  const scheduled = {
    ...automation,
    configuration: {
      ...automation.configuration,
      notifications: [],
      triggers: [{ frequency: "weekly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 }],
    },
    name: "Weekly digest",
  };
  const saves: Array<{ configuration: { notifications: unknown[] } }> = [];
  await page.route(`**/api/automations/${automationId}`, async (route) => {
    if (route.request().method() === "PUT") {
      saves.push(route.request().postDataJSON());
      return route.fulfill({ json: { updated: true } });
    }
    return route.fulfill({ json: { automation: scheduled } });
  });
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: [
      { id: slackAccountId, provider: "slack", displayName: "Acme Slack" },
      { id: datadogAccountId, provider: "datadog", displayName: "Datadog" },
      { id: "github", provider: "github", displayName: "superloglabs" },
    ],
    credentials: [],
    repositories: [{ id: repositoryIds[0], fullName: "superloglabs/responder" }, { id: repositoryIds[1], fullName: "superloglabs/responder-oss" }],
    resources: [
      { id: "ops", integrationAccountId: slackAccountId, kind: "slack_channel", externalId: "C100", displayName: "ops" },
      { id: "eng", integrationAccountId: slackAccountId, kind: "slack_channel", externalId: "C200", displayName: "eng" },
      // Enough channels that the list scrolls.
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `team-${index}`,
        integrationAccountId: slackAccountId,
        kind: "slack_channel",
        externalId: `C3${String(index).padStart(2, "0")}`,
        displayName: `team-${index}`,
      })),
    ],
    secrets: [], skills: [],
  } }));
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/settings`);
  await expect(page.getByRole("heading", { name: "Weekly digest" })).toBeVisible();

  await page.getByRole("button", { name: "Add notification" }).click();
  await page.getByRole("menuitem", { name: "Post to Slack" }).click();
  // The same searchable, scrolling channel picker as the Slack trigger.
  const picker = page.getByRole("dialog", { name: "Choose channel" });
  await expect(picker.getByRole("searchbox", { name: "Search channels" }).or(picker.getByRole("textbox", { name: "Search channels" }))).toBeFocused();
  const list = picker.locator(".automationResourcePicker__list");
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("automation-notifications-picker.png") });
  await page.keyboard.type("ops");
  await expect(picker.getByRole("radio")).toHaveCount(1);
  await picker.getByText("#ops").click();

  await expect(picker).toHaveCount(0);
  await expect.poll(() => saves.at(-1)?.configuration.notifications).toEqual([
    { channelId: "C100", integrationAccountId: slackAccountId, kind: "slack" },
  ]);
  const channel = page.getByRole("button", { name: "Channel" });
  await expect(channel).toContainText("#ops");
  await page.getByRole("heading", { name: "Notifications" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("automation-notifications.png") });

  await channel.click();
  await page.getByRole("dialog", { name: "Choose channel" }).getByText("#eng").click();
  await expect.poll(() => saves.at(-1)?.configuration.notifications).toEqual([
    { channelId: "C200", integrationAccountId: slackAccountId, kind: "slack" },
  ]);
});

test("shows notifications for a Sentry-triggered automation", async ({ page }) => {
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/settings`);
  await expect(page.getByRole("heading", { name: "Investigate production errors" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
});

test("hides notifications for a Slack-triggered automation", async ({ page }) => {
  const slackTriggered = {
    ...automation,
    configuration: {
      ...automation.configuration,
      triggers: [{ channelIds: ["C100"], eventMode: "mentions", integrationAccountId: "88888888-8888-4888-8888-888888888888", kind: "slack" }],
    },
    name: "Answer questions",
  };
  await page.route(`**/api/automations/${automationId}`, (route) => route.fulfill({ json: { automation: slackTriggered } }));
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/settings`);
  await expect(page.getByRole("heading", { name: "Answer questions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Notifications" })).toHaveCount(0);
});
