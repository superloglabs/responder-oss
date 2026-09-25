import { expect, test, type Page } from "@playwright/test";

const automationId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const chatRunId = "66666666-6666-4666-8666-666666666666";

const automation = {
  configuration: {
    contextAccountIds: [],
    harness: "codex",
    maxModelRequests: 24,
    maxOutputTokensPerRequest: 16_000,
    maxRuntimeSeconds: 1_800,
    model: "gpt-5.4",
    modelCredentialId: null,
    modelProvider: "openai",
    prompt: "Investigate the reported issue.",
    repositoryIds: ["11111111-1111-4111-8111-111111111111"],
    toolPolicy: "full",
    triggers: [{ eventTypes: ["new_issue"], integrationAccountId: "22222222-2222-4222-8222-222222222222", kind: "sentry", projectIds: ["responder-web"] }],
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

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const tools = (...items: Array<[string, string, Record<string, unknown>?]>) =>
  items.map(([action, target, extra]) => ({ action, kind: "tool", status: "succeeded", target, ...extra }));

const completedRun = {
  automationEnabled: true,
  automationId,
  automationName: "Investigate production errors",
  cancelRequestedAt: null,
  completedAt: minutesAgo(24),
  createdAt: minutesAgo(30),
  failureCategory: null,
  failureMessage: null,
  id: runId,
  number: 127,
  resultSummary: "PR #248 opened",
  startedAt: minutesAgo(30),
  status: "succeeded",
  trigger: {
    attributes: { action: "created", projectName: "responder-web", shortId: "RESP-2839" },
    provider: "sentry",
    sourceUrl: "https://sentry.example/issues/2839",
    title: "Payment webhook timeout",
  },
  events: [
    { createdAt: minutesAgo(30), data: {}, id: 1, type: "run_started" },
    { createdAt: minutesAgo(29), data: { items: [
      { kind: "message", text: "I'll trace the webhook timeout, check the related logs, and look for a fix in the selected repositories." },
      ...tools(["read", "src/webhooks/payments.ts"], ["read", "src/jobs/enrich-invoice.ts"], ["query", "get_issue", { provider: "sentry" }], ["query", "search_logs", { provider: "datadog" }]),
      { kind: "message", text: "The handler waits for invoice enrichment before acknowledging the webhook. When that service is slow, the request times out and the payment provider retries it.\n\nI'll acknowledge the event first and move enrichment to the background job." },
    ], truncated: false }, id: 2, type: "transcript" },
    { createdAt: minutesAgo(27), data: { authorId: "user", authorName: "Ada Lovelace", text: "Please add a regression test for duplicate events too." }, id: 3, type: "user_message" },
    { createdAt: minutesAgo(27), data: {}, id: 4, type: "run_started" },
    { createdAt: minutesAgo(25), data: { items: [
      { kind: "reasoning", observedAt: 4_000, text: "**Planning the regression test**\n\nA duplicate event should reuse the first job instead of enqueueing a second one." },
      ...tools(["read", "src/webhooks/payments.ts", { observedAt: 9_000 }], ["edit", "src/webhooks/payments.test.ts", { observedAt: 40_000 }], ["run", "pnpm test payments", { observedAt: 118_000 }]),
      { kind: "message", observedAt: 126_000, text: "Fixed the timeout and added duplicate-event coverage.\n\nThe webhook now acknowledges the event immediately and queues invoice enrichment. Repeated event IDs are skipped before a second job is created. All 12 tests pass." },
    ], startedAt: 0, truncated: false }, id: 5, type: "transcript" },
    { createdAt: minutesAgo(24), data: { externalReference: "https://github.com/superloglabs/responder-oss/pull/248", kind: "open_github_pull_request", repository: "superloglabs/responder-oss", title: "Fix payment webhook timeouts" }, id: 6, type: "action_succeeded" },
    { createdAt: minutesAgo(24), data: null, id: 7, type: "run_succeeded" },
  ],
};

const chatRun = {
  ...completedRun,
  completedAt: null,
  id: chatRunId,
  number: 128,
  resultSummary: null,
  status: "running",
  trigger: { attributes: {}, provider: "manual", sourceUrl: null, title: "Checkout returns a 500 for guest users" },
  events: [
    { createdAt: minutesAgo(0), data: { authorId: "user", authorName: "Ada Lovelace", text: "Checkout returns a 500 for guest users" }, id: 10, type: "user_message" },
    { createdAt: minutesAgo(0), data: {}, id: 11, type: "run_started" },
    { createdAt: minutesAgo(0), data: {}, id: 12, type: "sandbox_ready" },
  ],
};

const thinkingRun = {
  ...chatRun,
  events: [
    ...chatRun.events,
    { createdAt: minutesAgo(0), data: {}, id: 13, type: "repositories_checked_out" },
    { createdAt: minutesAgo(0), data: { items: [
      { kind: "message", text: "I'll reproduce the guest checkout first." },
      { kind: "reasoning", text: "**Finding the guest path**\n\nThe handler reads the session before checking whether the user is signed in." },
      { action: "read", kind: "tool", status: "succeeded", target: "src/checkout/handler.ts" },
    ], truncated: false }, id: 14, type: "transcript" },
  ],
};

async function mockApi(page: Page, overrides: { run?: Record<string, unknown> } = {}) {
  const requests: Array<{ body: unknown; path: string }> = [];
  await page.context().route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const organization = { id: "org", name: "Acme", slug: "acme" };
    if (method === "POST") requests.push({ body: route.request().postDataJSON(), path });
    if (path.endsWith("/get-session")) return route.fulfill({ json: {
      session: { id: "session", userId: "user", activeOrganizationId: "org", expiresAt: "2099-01-01T00:00:00Z" },
      user: { id: "user", name: "Ada Lovelace", email: "ada@example.com", emailVerified: true },
    } });
    if (path.endsWith("/organization/list")) return route.fulfill({ json: [organization] });
    if (path.endsWith("/organization/get-full-organization")) return route.fulfill({ json: organization });
    if (path === "/api/context") return route.fulfill({ json: { capabilities: ["automations"] } });
    if (path === "/api/billing") return route.fulfill({ json: { configured: false, enabled: false } });
    if (path === "/api/automations/options") return route.fulfill({ json: { accounts: [], resources: [], repositories: [], credentials: [], secrets: [] } });
    if (path === `/api/automations/${automationId}`) return route.fulfill({ json: { automation } });
    if (path === `/api/automations/${automationId}/runs` && method === "POST") return route.fulfill({ status: 202, json: { duplicate: false, runId: chatRunId } });
    if (path === `/api/automations/${automationId}/runs`) return route.fulfill({ json: { page: 1, pageSize: 10, total: 1, runs: [{
      completedAt: completedRun.completedAt, createdAt: completedRun.createdAt, failureCategory: null, failureMessage: null, id: runId,
      inferenceUsage: null, number: 127, resultSummary: "PR #248 opened", startedAt: completedRun.startedAt, status: "succeeded",
      trigger: { provider: "sentry", sourceUrl: completedRun.trigger.sourceUrl, title: completedRun.trigger.title }, usage: null,
    }] } });
    if (path === `/api/automations/runs/${runId}/messages`) return route.fulfill({ status: 202, json: { queued: true } });
    if (path === `/api/automations/runs/${runId}`) return route.fulfill({ json: { run: overrides.run ?? completedRun } });
    if (path === `/api/automations/runs/${chatRunId}`) return route.fulfill({ json: { run: chatRun } });
    if (path.startsWith("/api/automations/included-models/")) return route.fulfill({ json: { models: [{ id: "gpt-5.4", name: "GPT-5.4" }] } });
    return route.fulfill({ json: {} });
  });
  return requests;
}

test("shows a run as a chat transcript and sends a follow-up", async ({ page }, testInfo) => {
  const requests = await mockApi(page);
  await page.setViewportSize({ width: 1728, height: 1100 });
  await page.goto(`/automations/${automationId}/runs/${runId}`);

  await expect(page.getByRole("heading", { name: "Payment webhook timeout" })).toBeVisible();
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb).toContainText("Automations›Investigate production errors›Run #127");
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Trigger" })).toContainText("Sentry · New issue · RESP-2839");
  await expect(page.getByRole("link", { name: "Open in Sentry" })).toHaveAttribute("href", completedRun.trigger.sourceUrl);
  await expect(page.getByRole("article", { name: "Message from Ada Lovelace" })).toContainText("Please add a regression test");
  await expect(page.getByRole("button", { name: /Ran 4 tools/ })).toContainText("2 files read · Sentry and Datadog queried");
  await expect(page.getByRole("link", { name: "View pull request" })).toHaveAttribute("href", "https://github.com/superloglabs/responder-oss/pull/248");
  await expect(page.getByText("superloglabs / responder-oss · PR #248")).toBeVisible();

  const thought = page.getByRole("button", { name: /Thought for 2m 06s/ });
  await expect(thought).toContainText("Ran 3 tools · 1 file read · 1 file edited · 1 command run");
  await thought.click();
  await expect(page.getByText("A duplicate event should reuse the first job")).toBeVisible();
  await expect(page.getByText("pnpm test payments")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("automation-run.png"), fullPage: true });

  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await composer.fill("Also cover retries.");
  await composer.press("Enter");
  await expect.poll(() => requests.find((request) => request.path.endsWith("/messages"))?.body).toEqual({ message: "Also cover retries." });
  await expect(composer).toHaveValue("");
});

test("stops an active run and holds follow-ups until it finishes", async ({ page }, testInfo) => {
  const requests = await mockApi(page, { run: { ...chatRun, id: runId } });
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/runs/${runId}`);

  await expect(page.getByRole("status")).toHaveText("Checking out repositories");
  await expect(page.getByRole("article", { name: "Trigger" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("automation-run-active.png"), fullPage: true });
  await page.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => requests.some((request) => request.path === `/api/automations/runs/${runId}/cancel`)).toBe(true);
});

test("keeps the agent's current reasoning open while it thinks", async ({ page }, testInfo) => {
  await mockApi(page, { run: { ...thinkingRun, id: runId } });
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}/runs/${runId}`);

  const group = page.getByRole("button", { name: /Thinking/ });
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("The handler reads the session")).toBeVisible();
  await expect(page.getByText("src/checkout/handler.ts")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("automation-run-thinking.png"), fullPage: true });
});

test("types out a message that arrives while the page is open", async ({ page }) => {
  const answer = "Guest checkout reads the session before checking sign-in, so it throws for guests. I moved the check first.";
  let answered = false;
  await mockApi(page);
  await page.route(`**/api/automations/runs/${runId}`, (route) => {
    const events = !answered ? thinkingRun.events : [
      ...thinkingRun.events,
      { createdAt: minutesAgo(0), data: { items: [{ kind: "message", text: answer }], truncated: false }, id: 15, type: "transcript" },
    ];
    return route.fulfill({ json: { run: { ...thinkingRun, events, id: runId } } });
  });
  await page.goto(`/automations/${automationId}/runs/${runId}`);
  await expect(page.getByText("I'll reproduce the guest checkout first.")).toBeVisible();
  await expect(page.locator(".automationRun__message--typing")).toHaveCount(0);

  answered = true;
  await expect(page.locator(".automationRun__message--typing")).toHaveCount(1, { timeout: 5_000 });
  await expect(page.getByText(answer)).toBeVisible();
  await expect(page.locator(".automationRun__message--typing")).toHaveCount(0);
});

test("starts a test chat from the automation page", async ({ page }, testInfo) => {
  const requests = await mockApi(page);
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}`);
  await expect(page.getByRole("button", { name: "Test" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("automation-detail-test-button.png") });

  await page.getByRole("button", { name: "Test" }).click();
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}/test$`));
  await expect(page.getByRole("heading", { name: "Test chat" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("automation-test-chat.png"), fullPage: true });

  await composer.fill("Checkout returns a 500 for guest users");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}/runs/${chatRunId}$`));
  expect(requests.find((request) => request.path === `/api/automations/${automationId}/runs`)?.body).toEqual({ message: "Checkout returns a 500 for guest users" });
  await expect(page.getByRole("article", { name: "Message from Ada Lovelace" })).toContainText("Checkout returns a 500 for guest users");
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
});

test("opens a run from the run history", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto(`/automations/${automationId}`);
  await page.getByRole("tab", { name: "Run history" }).click();
  await page.getByRole("cell", { name: "Today" }).click();
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}/runs/${runId}$`));
  await expect(page.getByRole("heading", { name: "Payment webhook timeout" })).toBeVisible();
});
