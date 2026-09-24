import { expect, test } from "@playwright/test";

const repositoryId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const credentialId = "33333333-3333-4333-8333-333333333333";
const githubAccountId = "55555555-5555-4555-8555-555555555555";

test.beforeEach(async ({ context }) => {
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
      accounts: [{ id: accountId, provider: "slack", displayName: "Engineering" }, { id: githubAccountId, provider: "github", displayName: "acme" }],
      resources: [{ id: "channel", integrationAccountId: accountId, kind: "slack_channel", externalId: "C123", displayName: "#incidents" }],
      repositories: [{ id: repositoryId, fullName: "acme/api" }],
      credentials: [{ id: credentialId, provider: "openai", label: "Team key", lastFour: "1234", status: "active" }],
      secrets: [],
    } });
    if (/\/credentials\/[^/]+\/models$/.test(path)) return route.fulfill({ json: { models: [{ id: "gpt-5.4", name: "GPT-5.4" }] } });
    if (path === "/api/automations/included-models/openai") return route.fulfill({ json: { models: [{ id: "gpt-5.4", name: "GPT-5.4" }] } });
    if (path.startsWith("/api/automations/included-models/")) return route.fulfill({ json: { models: [{ id: "included-model", name: "Included Model" }] } });
    return route.fulfill({ json: {} });
  });
});

test("creates an automation using the compact editor and selected resources", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto("/automations/new");
  await expect(page.getByRole("heading", { name: "New automation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose model", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await page.getByRole("menuitem", { name: "OpenAI", exact: true }).click();
  await page.getByRole("option", { name: "GPT-5.4" }).click();
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toBeEmpty();
  await expect(page.getByRole("button", { name: "Add repository", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("automation-create-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Rename automation" }).click();
  await page.getByLabel("Automation name").fill("Fix incoming issues");
  await page.getByLabel("Automation name").press("Enter");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Investigate the event and open a pull request.");
  await page.getByRole("button", { name: "Add connector", exact: true }).click();
  await page.getByRole("option", { name: /^Engineering/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Remove Engineering" })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Trigger providers" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Slack", exact: true }).click();
  await page.getByRole("menuitem", { name: "New message in channel", exact: true }).click();
  await page.getByRole("button", { name: "Channel", exact: true }).click();
  await page.getByRole("checkbox", { name: "#incidents", exact: true }).check();
  await page.getByRole("dialog", { name: "Choose channels" }).press("Escape");
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await page.getByRole("option", { name: "acme/api" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Remove acme/api" })).toBeVisible();
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/automations", async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { error: "Please try again" } });
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saved).toMatchObject({ name: "Fix incoming issues", configuration: {
    repositoryIds: [repositoryId], modelCredentialId: null, contextAccountIds: [],
    trigger: { integrationAccountId: accountId, channelIds: ["C123"], kind: "slack", eventMode: "every_message" },
  } });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});

test("keeps the create page usable on mobile and restores focus after closing the trigger menu", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/automations/new");
  const add = page.getByRole("button", { name: "Add trigger", exact: true });
  await add.click();
  await page.getByRole("menu", { name: "Trigger providers" }).press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(add).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("automation-create-mobile.png"), fullPage: true });
});


test("chooses and configures Sentry inline with only supported options", async ({ page }, testInfo) => {
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: [
      { id: accountId, provider: "sentry", displayName: "Acme workspace" },
      { id: "other", provider: "sentry", displayName: "Other workspace" },
    ],
    resources: [{ id: "project", integrationAccountId: accountId, kind: "sentry_project", externalId: "responder-web", displayName: "responder-web" }],
    repositories: [{ id: repositoryId, fullName: "acme/api" }], credentials: [], secrets: [],
  } }));
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await expect(page.locator(".automationTrigger__providerOption")).toHaveCount(3);
  await page.getByRole("menuitem", { name: "Sentry", exact: true }).focus();
  await page.screenshot({ path: testInfo.outputPath("automation-choose-trigger.png"), fullPage: true });
  await page.getByRole("menuitem", { name: "Sentry", exact: true }).click();
  await page.getByRole("menuitem", { name: "New issue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Project", exact: true })).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Event", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("checkbox", { name: "responder-web", exact: true }).check();
  await page.getByRole("dialog", { name: "Choose projects" }).press("Escape");
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("automation-configure-trigger.png"), fullPage: true });
  await page.getByRole("combobox", { name: "Trigger connection", exact: true }).selectOption("other");
  await expect(page.getByRole("button", { name: "Project", exact: true })).toHaveText("Select project");
  await page.getByRole("button", { name: "Remove Sentry trigger" }).click();
  await expect(page.getByRole("button", { name: "Add trigger", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Slack", exact: true }).click();
  await page.getByRole("menuitem", { name: "New message in channel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
});


test("searches events and navigates the provider flyout with the keyboard", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search triggers" });
  await expect(search).toBeFocused();
  await search.fill("reaction");
  await expect(page.getByRole("status")).toHaveText("No triggers found.");
  await search.fill("mentioned");
  await expect(page.locator(".automationTrigger__providerOption")).toHaveCount(1);
  await search.press("ArrowDown");
  await page.getByRole("menuitem", { name: "Slack", exact: true }).press("ArrowRight");
  await expect(page.getByRole("menuitem", { name: "App mentioned", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("automation-trigger-flyout.png"), fullPage: true });
  await page.getByRole("menuitem", { name: "App mentioned", exact: true }).press("Escape");
  await expect(page.getByRole("menuitem", { name: "Slack", exact: true })).toBeFocused();
  await expect(page.getByRole("menu", { name: "Slack events" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Slack", exact: true }).press("ArrowRight");
  await page.getByRole("menuitem", { name: "App mentioned", exact: true }).press("Enter");
  await expect(page.getByText("Slack app mentioned", { exact: true })).toBeVisible();
});


test("connects from the trigger card and preserves the automation draft", async ({ page, context }, testInfo) => {
  let connected = false;
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: connected ? [{ id: accountId, provider: "slack", displayName: "Engineering" }] : [],
    resources: connected ? [{ id: "channel", integrationAccountId: accountId, kind: "slack_channel", externalId: "C123", displayName: "#incidents" }] : [],
    repositories: [], credentials: [], secrets: [],
  } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: {
    integrations: [{ id: "slack", connectUrl: "/api/integrations/slack/start" }],
  } }));
  await context.route("**/api/integrations/slack/start?**", async (route) => {
    const url = new URL(route.request().url());
    const destination = new URL(url.searchParams.get("returnTo")!, url.origin);
    expect(destination.pathname).toBe("/automations/connection-complete");
    destination.searchParams.set("integration", "slack");
    destination.searchParams.set("status", "connected");
    connected = true;
    await route.fulfill({ status: 302, headers: { location: destination.toString() } });
  });
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto("/automations/new");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Keep this unsaved draft.");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Slack", exact: true }).click();
  await page.getByRole("menuitem", { name: "New message in channel", exact: true }).click();
  await expect(page.getByText("Connect Slack to use this trigger")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("automation-connect-trigger.png"), fullPage: true });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const popup = await popupPromise;
  await expect(page.getByRole("button", { name: "Channel", exact: true })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page).toHaveURL(/\/automations\/new$/);
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue("Keep this unsaved draft.");
  await expect(page.getByText("Slack message posted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Channel", exact: true }).click();
  await page.getByRole("checkbox", { name: "#incidents", exact: true }).check();
  await page.getByRole("dialog", { name: "Choose channels" }).press("Escape");
});

test("connects GitHub from the repositories section and searches its repositories", async ({ page, context }, testInfo) => {
  let connected = false;
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: connected ? [{ id: githubAccountId, provider: "github", displayName: "acme" }] : [],
    resources: [],
    repositories: connected ? [{ id: repositoryId, fullName: "acme/api" }, { id: "66666666-6666-4666-8666-666666666666", fullName: "acme/web" }] : [],
    credentials: [], secrets: [],
  } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: {
    integrations: [{ id: "github", connectUrl: "/api/integrations/github/start?mode=install" }],
  } }));
  await context.route("**/api/integrations/github/start?**", async (route) => {
    const url = new URL(route.request().url());
    const destination = new URL(url.searchParams.get("returnTo")!, url.origin);
    destination.searchParams.set("integration", "github");
    destination.searchParams.set("status", "connected");
    connected = true;
    await route.fulfill({ status: 302, headers: { location: destination.toString() } });
  });
  await page.goto("/automations/new");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Keep this unsaved draft.");
  await expect(page.getByRole("button", { name: "Add repository" })).toHaveCount(0);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Add GitHub", exact: true }).click();
  const popup = await popupPromise;
  await expect.poll(() => popup.isClosed()).toBe(true);
  const search = page.getByPlaceholder("Search repositories…");
  await expect(search).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue("Keep this unsaved draft.");
  await search.fill("web");
  await expect(page.getByRole("option", { name: "acme/api" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("automation-repository-search.png") });
  await page.keyboard.press("Enter");
  await search.fill("");
  await page.getByRole("option", { name: "acme/api" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Remove acme/web" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove acme/api" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add repository" })).toBeFocused();
});

test("connects a missing connector in the same tab and restores the draft", async ({ page, context }, testInfo) => {
  let connected = false;
  const datadogAccountId = "77777777-7777-4777-8777-777777777777";
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: [{ id: githubAccountId, provider: "github", displayName: "acme" }, ...(connected ? [{ id: datadogAccountId, provider: "datadog", displayName: "Datadog US1" }] : [])],
    resources: [], repositories: [{ id: repositoryId, fullName: "acme/api" }], credentials: [], secrets: [],
  } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: {
    integrations: [{ id: "datadog", connectUrl: "/api/integrations/datadog/connect" }],
  } }));
  let submitted: Record<string, unknown> | undefined;
  await context.route("**/api/integrations/datadog/connect", async (route) => {
    submitted = route.request().postDataJSON();
    connected = true;
    const redirectUrl = new URL(String(submitted?.returnTo), route.request().url());
    redirectUrl.searchParams.set("integration", "datadog");
    redirectUrl.searchParams.set("status", "connected");
    await route.fulfill({ json: { accountId: datadogAccountId, redirectUrl: redirectUrl.toString() } });
  });
  await page.goto("/automations/new");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Keep this unsaved draft.");
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await page.getByRole("option", { name: "acme/api" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add connector", exact: true }).click();
  await expect(page.getByRole("option", { name: /Connect Slack/ })).toBeVisible();
  await page.getByPlaceholder("Search connectors…").fill("data");
  await expect(page.getByRole("option", { name: /Slack/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("automation-connector-search.png") });
  await page.getByRole("option", { name: /Connect Datadog/ }).click();
  await page.getByPlaceholder("Paste your Datadog API key").fill("api-key");
  await page.getByPlaceholder("Paste your Datadog application key").fill("application-key");
  await page.getByRole("button", { name: "Connect Datadog", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Datadog US1" })).toBeVisible();
  expect(submitted).toMatchObject({ returnTo: "/automations/new" });
  await expect(page).toHaveURL(/\/automations\/new$/);
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue("Keep this unsaved draft.");
  await expect(page.getByRole("button", { name: "Remove acme/api" })).toBeVisible();
});

test("connects an OAuth connector in the same tab", async ({ page, context }) => {
  let connected = false;
  const slackAccountId = "88888888-8888-4888-8888-888888888888";
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: connected ? [{ id: slackAccountId, provider: "slack", displayName: "Engineering" }] : [],
    resources: [], repositories: [], credentials: [], secrets: [],
  } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: {
    integrations: [{ id: "slack", connectUrl: "/api/integrations/slack/start" }],
  } }));
  await context.route("**/api/integrations/slack/start?**", async (route) => {
    const url = new URL(route.request().url());
    const destination = new URL(url.searchParams.get("returnTo")!, url.origin);
    destination.searchParams.set("integration", "slack");
    destination.searchParams.set("status", "connected");
    connected = true;
    await route.fulfill({ status: 302, headers: { location: destination.toString() } });
  });
  await page.goto("/automations/new");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Keep this unsaved draft.");
  await page.getByRole("button", { name: "Add connector", exact: true }).click();
  await page.getByRole("option", { name: /Connect Slack/ }).click();
  await expect(page.getByRole("button", { name: "Remove Engineering" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue("Keep this unsaved draft.");
  await expect(page).toHaveURL(/\/automations\/new$/);
});

test("returns a Sentry connection that finishes on settings to the draft", async ({ page, context }) => {
  let started = false;
  let loadsAfterReturn = 0;
  const sentryAccountId = "99999999-9999-4999-8999-999999999999";
  await page.route("**/api/automations/options", (route) => {
    if (started) loadsAfterReturn++;
    return route.fulfill({ json: {
      accounts: loadsAfterReturn > 2 ? [{ id: sentryAccountId, provider: "sentry", displayName: "Acme Sentry" }] : [],
      resources: [], repositories: [], credentials: [], secrets: [],
    } });
  });
  await page.route("**/api/integrations", (route) => route.fulfill({ json: {
    integrations: [{ id: "sentry", connectUrl: "/api/integrations/sentry/start" }],
  } }));
  await context.route("**/api/integrations/sentry/start?**", async (route) => {
    started = true;
    await route.fulfill({ status: 302, headers: { location: new URL("/settings?integration=sentry&status=finishing", route.request().url()).toString() } });
  });
  await page.goto("/automations/new");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Keep this unsaved draft.");
  await page.getByRole("button", { name: "Add connector", exact: true }).click();
  await page.getByRole("option", { name: /Connect Sentry/ }).click();
  await expect(page).toHaveURL(/\/automations\/new$/);
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue("Keep this unsaved draft.");
  await expect(page.getByRole("button", { name: "Remove Acme Sentry" })).toBeVisible({ timeout: 10_000 });
});

test("shows connection setup errors on the trigger card", async ({ page }) => {
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: [], resources: [], repositories: [], credentials: [], secrets: [],
  } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: {
    integrations: [{ id: "slack", connectUrl: null }],
  } }));
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Slack", exact: true }).click();
  await page.getByRole("menuitem", { name: "New message in channel", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Slack connections are not configured for this installation.");
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
});


test("searches channels by name or ID, selects multiple, and refreshes the list", async ({ page }, testInfo) => {
  let refreshed = false;
  await page.route("**/api/agents/options/refresh/slack", async (route) => {
    expect(route.request().method()).toBe("POST");
    refreshed = true;
    await route.fulfill({ json: {} });
  });
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: [{ id: accountId, provider: "slack", displayName: "Superlog" }],
    resources: [
      { id: "first", integrationAccountId: accountId, kind: "slack_channel", externalId: "C123", displayName: "01-superlog-issues" },
      { id: "second", integrationAccountId: accountId, kind: "slack_channel", externalId: "C456", displayName: "all-nbax" },
      ...(refreshed ? [{ id: "third", integrationAccountId: accountId, kind: "slack_channel", externalId: "C789", displayName: "new-channel" }] : []),
    ], repositories: [], credentials: [], secrets: [],
  } }));
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Slack", exact: true }).click();
  await page.getByRole("menuitem", { name: "New message in channel", exact: true }).click();
  await page.getByRole("button", { name: "Channel", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search channels" });
  await search.fill("C456");
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await page.getByText("all-nbax", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "all-nbax" })).toBeChecked();
  await expect(search).toBeVisible();
  await page.locator(".automationResourcePicker__option").click({ position: { x: 180, y: 15 } });
  await expect(page.getByRole("checkbox", { name: "all-nbax" })).not.toBeChecked();
  await page.getByText("all-nbax", { exact: true }).click();
  await search.fill("issues");
  await page.getByRole("checkbox", { name: "01-superlog-issues" }).check();
  await search.fill("");
  await page.getByRole("button", { name: "Refresh channels" }).click();
  await expect(page.getByRole("checkbox", { name: "new-channel" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "all-nbax" })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("automation-channel-picker.png"), fullPage: true });
  await search.press("Escape");
  await expect(page.getByRole("button", { name: "Channel", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Channel", exact: true })).toContainText("all-nbax, 01-superlog-issues");
  await page.screenshot({ path: testInfo.outputPath("automation-event-card.png"), fullPage: true });
});

test("chooses included models from the provider submenu and filters compatible harnesses", async ({ page }, testInfo) => {
  await page.goto("/automations/new");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Keep my instructions");
  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("menuitem", { name: "Anthropic", exact: true }).click();
  await page.getByRole("option", { name: "Included Model" }).click();
  await expect(page.getByRole("button", { name: "Model: included-model" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue("Keep my instructions");
  await page.getByRole("button", { name: /^Harness:/ }).click();
  await page.getByRole("menuitemradio", { name: "Anthropic Anthropic agent harness" }).click();
  await page.getByRole("button", { name: /^Model:/ }).click();
  await page.getByRole("menuitem", { name: "OpenAI", exact: true }).click();
  await page.getByRole("option", { name: "GPT-5.4" }).click();
  await page.getByRole("button", { name: "Harness: Codex" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Anthropic Anthropic agent harness" })).toHaveCount(0);
  await page.getByRole("menuitemradio", { name: "OpenCode OpenCode agent harness" }).click();
  await expect(page.getByRole("button", { name: "Harness: OpenCode" })).toBeFocused();
  await page.getByRole("button", { name: /^Model:/ }).click();
  await page.getByRole("menuitem", { name: "OpenAI", exact: true }).hover();
  await page.screenshot({ path: testInfo.outputPath("automation-model-picker.png"), fullPage: true });
});

test("shows six providers and selects a model from the provider submenu", async ({ page }, testInfo) => {
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Choose model" }).click();
  const providers = page.getByRole("menu", { name: "Choose model" });
  await expect(providers.getByRole("menuitem")).toHaveCount(6);
  for (const name of ["OpenAI", "Anthropic", "Google Gemini", "xAI", "Mistral", "DeepSeek"]) await expect(providers.getByRole("menuitem", { name, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("automation-providers.png") });
  await providers.getByRole("menuitem", { name: "Google Gemini", exact: true }).hover();
  const models = page.getByRole("menu", { name: "Google Gemini" });
  await expect(models.getByRole("option", { name: "Included Model" })).toBeVisible();
  await expect(providers).toBeVisible();
  await expect(providers.getByRole("menuitem", { name: "Google Gemini", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Add connection")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("automation-model-submenu.png") });
  await models.getByRole("option", { name: "Included Model" }).click();
  await expect(page.getByRole("button", { name: "Model: included-model" })).toBeVisible();
  await page.getByRole("button", { name: "Harness: OpenCode" }).click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(1);
});

test("keeps removed resources deselectable after a refresh", async ({ page }) => {
  let refreshed = false;
  await page.route("**/api/agents/options/refresh/slack", route => { refreshed = true; return route.fulfill({ json: {} }); });
  await page.route("**/api/automations/options", route => route.fulfill({ json: {
    accounts: [{ id: accountId, provider: "slack", displayName: "Engineering" }],
    resources: refreshed ? [] : [{ id: "channel", integrationAccountId: accountId, kind: "slack_channel", externalId: "C123", displayName: "#incidents" }],
    repositories: [], credentials: [], secrets: [],
  } }));
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Slack", exact: true }).click();
  await page.getByRole("menuitem", { name: "New message in channel", exact: true }).click();
  await page.getByRole("button", { name: "Channel", exact: true }).click();
  await page.getByRole("checkbox", { name: "#incidents" }).check();
  await page.getByRole("button", { name: "Refresh channels" }).click();
  await page.getByRole("checkbox", { name: "C123 (unavailable)" }).click();
  await page.getByRole("textbox", { name: "Search channels" }).press("Escape");
  await expect(page.getByRole("button", { name: "Channel", exact: true })).toContainText("Select channel");
});

test("searches models and navigates the submenus with the keyboard", async ({ page }) => {
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Choose model", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "OpenAI", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Anthropic", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const search = page.getByPlaceholder("Search models…");
  await expect(search).toBeFocused();
  await page.keyboard.type("nothing like this");
  await expect(page.getByText("No models found.")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("menu", { name: "Anthropic" })).toBeVisible();
  await search.fill("");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("menu", { name: "Anthropic" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Anthropic", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: "OpenAI", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(search).toBeFocused();
  await page.keyboard.type("gpt");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Model: gpt-5.4" })).toBeFocused();
});

test("completes an asynchronous Sentry connection without losing the draft", async ({ page, context }, testInfo) => {
  let connected = false;
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: {
    accounts: connected ? [{ id: accountId, provider: "sentry", displayName: "Engineering" }] : [],
    resources: connected ? [{ id: "channel", integrationAccountId: accountId, kind: "sentry_project", externalId: "C123", displayName: "#incidents" }] : [],
    repositories: [], credentials: [], secrets: [],
  } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: {
    integrations: [{ id: "sentry", connectUrl: "/api/integrations/sentry/start" }],
  } }));
  await context.route("**/api/integrations/sentry/start?**", async (route) => {
    const url = new URL(route.request().url());
    const destination = new URL(url.searchParams.get("returnTo")!, url.origin);
    expect(destination.pathname).toBe("/automations/connection-complete");
    destination.searchParams.set("integration", "sentry");
    destination.searchParams.set("status", "finishing");
    connected = true;
    await route.fulfill({ status: 302, headers: { location: destination.toString() } });
  });
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto("/automations/new");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Keep this unsaved draft.");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sentry", exact: true }).click();
  await page.getByRole("menuitem", { name: "New issue", exact: true }).click();
  await expect(page.getByText("Connect Sentry to use this trigger")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("automation-connect-trigger.png"), fullPage: true });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const popup = await popupPromise;
  await expect(page.getByRole("button", { name: "Project", exact: true })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page).toHaveURL(/\/automations\/new$/);
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue("Keep this unsaved draft.");
  await expect(page.getByText("Sentry new issue", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("checkbox", { name: "#incidents", exact: true }).check();
  await page.getByRole("dialog", { name: "Choose projects" }).press("Escape");
});

test("stops connection refresh retries after removing the trigger", async ({ page, context }) => {
  let loads = 0;
  await page.route("**/api/automations/options", (route) => {
    loads++;
    return route.fulfill({ json: { accounts: [], resources: [], repositories: [], credentials: [], secrets: [] } });
  });
  await page.route("**/api/integrations", (route) => route.fulfill({ json: {
    integrations: [{ id: "sentry", connectUrl: "/api/integrations/sentry/start" }],
  } }));
  await context.route("**/api/integrations/sentry/start?**", async (route) => {
    const url = new URL(route.request().url());
    const destination = new URL(url.searchParams.get("returnTo")!, url.origin);
    destination.searchParams.set("integration", "sentry");
    destination.searchParams.set("status", "finishing");
    await route.fulfill({ status: 302, headers: { location: destination.toString() } });
  });
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sentry", exact: true }).click();
  await page.getByRole("menuitem", { name: "New issue", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => loads).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Remove Sentry trigger" }).click();
  const stoppedAt = loads;
  // Wait beyond the retry interval to detect an orphaned polling loop.
  await page.waitForTimeout(2200);
  expect(loads).toBe(stoppedAt);
  await expect(page.getByRole("button", { name: "Add trigger", exact: true })).toBeVisible();
});

test("preserves the selected Discord server after reconnecting", async ({ page, context }) => {
  const secondAccountId = "44444444-4444-4444-8444-444444444444";
  await page.route("**/api/automations/options", route => route.fulfill({ json: {
    accounts: [
      { id: accountId, provider: "discord", displayName: "First server" },
      { id: secondAccountId, provider: "discord", displayName: "Selected server" },
    ], resources: [], repositories: [], credentials: [], secrets: [],
  } }));
  await page.route("**/api/integrations", route => route.fulfill({ json: {
    integrations: [{ id: "discord", connectUrl: "/api/integrations/discord/start" }],
  } }));
  await context.route("**/api/integrations/discord/start?**", async route => {
    const url = new URL(route.request().url());
    const destination = new URL(url.searchParams.get("returnTo")!, url.origin);
    destination.searchParams.set("integration", "discord");
    destination.searchParams.set("status", "connected");
    await route.fulfill({ status: 302, headers: { location: destination.toString() } });
  });
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Discord", exact: true }).click();
  await page.getByRole("menuitem", { name: "Automation command in channel", exact: true }).click();
  await page.getByRole("combobox", { name: "Trigger connection" }).selectOption(secondAccountId);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Reconnect to refresh channels" }).click();
  const popup = await popupPromise;
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByRole("button", { name: "Reconnect to refresh channels" })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Trigger connection" })).toHaveValue(secondAccountId);
});
