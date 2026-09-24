import { expect, test } from "@playwright/test";

const repositoryId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const credentialId = "33333333-3333-4333-8333-333333333333";

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
      accounts: [{ id: accountId, provider: "slack", displayName: "Engineering" }],
      resources: [{ id: "channel", integrationAccountId: accountId, kind: "slack_channel", externalId: "C123", displayName: "#incidents" }],
      repositories: [{ id: repositoryId, fullName: "acme/api" }],
      credentials: [{ id: credentialId, provider: "openai", label: "Team key", lastFour: "1234", status: "active" }],
      secrets: [],
    } });
    if (/\/credentials\/[^/]+\/models$/.test(path)) return route.fulfill({ json: { models: [{ id: "gpt-5.4", name: "GPT-5.4" }] } });
    return route.fulfill({ json: {} });
  });
});

test("creates an automation using the compact editor and selected resources", async ({ page }) => {
  await page.setViewportSize({ width: 1728, height: 997 });
  await page.goto("/automations/new");
  await expect(page.getByRole("heading", { name: "New automation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose model", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page.getByRole("button", { name: "GPT-5.4" }).click();
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toBeEmpty();
  await expect(page.getByRole("button", { name: "Add repository", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/automation-create-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Rename automation" }).click();
  await page.getByLabel("Automation name").fill("Fix incoming issues");
  await page.getByLabel("Automation name").press("Enter");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Investigate the event and open a pull request.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Trigger providers" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Slack", exact: true }).click();
  await page.getByRole("menuitem", { name: "New message in channel", exact: true }).click();
  await page.getByRole("button", { name: "Channel", exact: true }).click();
  await page.getByRole("checkbox", { name: "#incidents", exact: true }).check();
  await page.getByRole("dialog", { name: "Choose channels" }).press("Escape");
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await page.getByLabel("acme/api").check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/automations", async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { error: "Please try again" } });
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saved).toMatchObject({ name: "Fix incoming issues", configuration: {
    repositoryIds: [repositoryId], modelCredentialId: credentialId,
    trigger: { integrationAccountId: accountId, channelIds: ["C123"], kind: "slack", eventMode: "every_message" },
  } });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});

test("keeps the create page usable on mobile and restores focus after closing the trigger menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/automations/new");
  const add = page.getByRole("button", { name: "Add trigger", exact: true });
  await add.click();
  await page.getByRole("menu", { name: "Trigger providers" }).press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(add).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/automation-create-mobile.png", fullPage: true });
});


test("chooses and configures Sentry inline with only supported options", async ({ page }) => {
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
  await page.screenshot({ path: "/tmp/automation-choose-trigger.png", fullPage: true });
  await page.getByRole("menuitem", { name: "Sentry", exact: true }).click();
  await page.getByRole("menuitem", { name: "New issue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Project", exact: true })).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Event", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("checkbox", { name: "responder-web", exact: true }).check();
  await page.getByRole("dialog", { name: "Choose projects" }).press("Escape");
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "/tmp/automation-configure-trigger.png", fullPage: true });
  await page.getByRole("combobox", { name: "Trigger connection", exact: true }).selectOption("other");
  await expect(page.getByRole("button", { name: "Project", exact: true })).toHaveText("Select project");
  await page.getByRole("button", { name: "Remove Sentry trigger" }).click();
  await expect(page.getByRole("button", { name: "Add trigger", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Slack", exact: true }).click();
  await page.getByRole("menuitem", { name: "New message in channel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
});


test("searches events and navigates the provider flyout with the keyboard", async ({ page }) => {
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
  await page.screenshot({ path: "/tmp/automation-trigger-flyout.png", fullPage: true });
  await page.getByRole("menuitem", { name: "App mentioned", exact: true }).press("Escape");
  await expect(page.getByRole("menuitem", { name: "Slack", exact: true })).toBeFocused();
  await expect(page.getByRole("menu", { name: "Slack events" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Slack", exact: true }).press("ArrowRight");
  await page.getByRole("menuitem", { name: "App mentioned", exact: true }).press("Enter");
  await expect(page.getByText("Slack app mentioned", { exact: true })).toBeVisible();
});


test("connects from the trigger card and preserves the automation draft", async ({ page, context }) => {
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
  await page.screenshot({ path: "/tmp/automation-connect-trigger.png", fullPage: true });
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


test("searches channels by name or ID, selects multiple, and refreshes the list", async ({ page }) => {
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
  await page.screenshot({ path: "/tmp/automation-channel-picker.png", fullPage: true });
  await search.press("Escape");
  await expect(page.getByRole("button", { name: "Channel", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Channel", exact: true })).toContainText("all-nbax, 01-superlog-issues");
  await page.screenshot({ path: "/tmp/automation-event-card.png", fullPage: true });
});

test("connects a model inline and filters compatible harnesses", async ({ page }) => {
  let savedKey: unknown;
  let fail = true;
  await page.route("**/api/automations/credentials", async (route) => {
    savedKey = route.request().postDataJSON();
    await route.fulfill(fail ? { status: 400, json: { error: "Invalid API key" } } : { json: { credentialId } });
  });
  await page.route(`**/api/automations/credentials/${credentialId}/models*`, route => route.fulfill({ json: { models: [{ id: "claude-sonnet-current", name: "Claude Sonnet Current" }, { id: "gpt-5.4", name: "GPT-5.4" }] } }));
  await page.goto("/automations/new");
  await page.getByRole("textbox", { name: "Agent instructions" }).fill("Keep my instructions");
  await page.getByRole("button", { name: /^(Model:|Choose model)/ }).click();
  await page.getByRole("button", { name: "Anthropic", exact: true }).click();
  const connection = page.getByRole("dialog", { name: "Connect Anthropic" });
  await expect(connection.getByLabel("Key name")).toHaveCount(0);
  await connection.getByLabel("API key", { exact: true }).fill("test-only-key");
  await connection.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connection.getByRole("alert")).toContainText("Invalid API key");
  await expect(connection.getByLabel("API key", { exact: true })).toHaveValue("test-only-key");
  fail = false;
  await connection.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connection).toHaveCount(0);
  expect(savedKey).toEqual({ provider: "anthropic", apiKey: "test-only-key", label: expect.stringMatching(/^Anthropic key /) });
  await page.getByRole("button", { name: "Claude Sonnet Current" }).click();
  await expect(page.getByRole("textbox", { name: "Agent instructions" })).toHaveValue("Keep my instructions");
  await page.getByRole("button", { name: /^Harness:/ }).click();
  await page.getByRole("menuitemradio", { name: "Anthropic Anthropic agent harness" }).click();
  await page.getByRole("button", { name: /^(Model:|Choose model)/ }).click();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page.getByRole("button", { name: "GPT-5.4" }).click();
  await page.getByRole("button", { name: "Harness: Codex" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Anthropic Anthropic agent harness" })).toHaveCount(0);
  await page.getByRole("menuitemradio", { name: "OpenCode OpenCode agent harness" }).click();
  await expect(page.getByRole("button", { name: "Harness: OpenCode" })).toBeFocused();
  await page.getByRole("button", { name: /^(Model:|Choose model)/ }).click();
  await page.screenshot({ path: "/tmp/automation-model-picker.png", fullPage: true });
});

test("retries a temporary subscription polling failure without losing the draft and restricts harnesses", async ({ page }) => {
  let connected = false;
  let cancelled = false;
  let polls = 0;
  const connectionId = "44444444-4444-4444-8444-444444444444";
  await page.route("**/api/automations/options", (route) => route.fulfill({ json: { accounts: [], resources: [], repositories: [], secrets: [], credentials: connected ? [{ id: credentialId, provider: "openai", authType: "chatgpt_subscription", label: "ChatGPT subscription", status: "active", lastFour: "" }] : [] } }));
  await page.route("**/api/automations/subscriptions/openai", (route) => route.fulfill({ json: { connectionId, userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device", interval: 1, expiresAt: new Date(Date.now() + 60000).toISOString() } }));
  await page.route(`**/api/automations/subscriptions/openai/${connectionId}`, async (route) => { cancelled = true; await route.fulfill({ json: { ok: true } }); });
  await page.route(`**/api/automations/subscriptions/openai/${connectionId}/poll`, async (route) => {
    if (++polls === 1) { await route.fulfill({ status: 502, json: { error: "Temporary sandbox connection failure" } }); return; }
    connected = true; await route.fulfill({ json: { status: "connected", credentialId } });
  });
  await page.goto("/automations/new");
  await expect(page.getByRole("button", { name: "Choose model" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Harness:/ })).toBeDisabled();
  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page.getByRole("button", { name: "Subscription · BYOS" }).click();
  await page.getByRole("button", { name: "Connect subscription ↗" }).click();
  await expect(page.getByText("ABCD-EFGH")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue to ChatGPT ↗" })).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  await expect(page.getByRole("dialog", { name: "Connect OpenAI" })).toHaveCount(0);
  await page.getByRole("button", { name: "GPT-5.4" }).click();
  await page.getByRole("button", { name: "Harness: Codex" }).click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(1);
  await expect.poll(() => cancelled).toBe(true);
});

test("shows seven providers and loads, refreshes, and selects models from the chosen connection", async ({ page }) => {
  let loads = 0;
  await page.route("**/api/automations/options", route => route.fulfill({ json: { accounts: [], resources: [], repositories: [], secrets: [], credentials: [{ id: credentialId, provider: "google", label: "Gemini team", status: "active", lastFour: "1234" }] } }));
  await page.route(`**/api/automations/credentials/${credentialId}/models*`, route => route.fulfill({ json: { models: ++loads === 1 ? [{ id: "gemini-current", name: "Gemini Current" }] : [{ id: "gemini-new", name: "Gemini Newly Available" }] } }));
  await page.goto("/automations/new");
  await page.getByRole("button", { name: "Choose model" }).click();
  const providers = page.getByRole("dialog", { name: "Choose a provider" });
  for (const name of ["OpenAI", "Anthropic", "Google Gemini", "xAI", "Mistral", "DeepSeek", "Groq"]) await expect(providers.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(providers.getByText("OpenRouter")).toHaveCount(0);
  await expect(providers.getByText("Together AI")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/automation-providers.png" });
  await providers.getByRole("button", { name: "Google Gemini", exact: true }).click();
  await expect(page.getByRole("button", { name: "Gemini Current gemini-current" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh models" }).click();
  await expect(page.getByRole("button", { name: "Gemini Newly Available gemini-new" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gemini Current gemini-current" })).toHaveCount(0);
  await page.screenshot({ path: "/tmp/automation-live-models.png" });
  await page.getByRole("button", { name: "Gemini Newly Available gemini-new" }).click();
  await expect(page.getByRole("button", { name: "Model: gemini-new" })).toBeVisible();
  await page.getByRole("button", { name: "Harness: OpenCode" }).click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(1);
});
