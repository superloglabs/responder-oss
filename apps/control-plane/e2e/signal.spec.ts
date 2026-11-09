import { expect, test, type Page } from "@playwright/test";

interface FakeFinding {
  id: string; title: string; subtitle: string; severity: "SEV-1" | "SEV-2"; service: string;
  status: "new" | "accepted" | "irrelevant"; postedAt: string;
}

const signalPlans = [
  { id: "signal_pro", name: "Pro", price: 100, included: 50 },
  { id: "signal_max", name: "Max", price: 200, included: 100 },
];

// A Signal API in memory: findings, usage, settings, and the plan, with
// every write recorded.
function fakeSignal(count = 30, options: { setUp?: boolean } = {}) {
  const now = Date.now();
  const findings: FakeFinding[] = Array.from({ length: count }, (_, index) => ({
    id: `SIG-${String(count - index).padStart(3, "0")}`,
    title: index === 0 ? "Checkout requests time out after the payment client retry change" : `Background job ${index} fails for some workspaces`,
    subtitle: index === 0 ? "18 checkout attempts from 11 customers timed out in the last 2 hours." : "A few workspaces are affected.",
    severity: index % 4 === 0 ? "SEV-1" : "SEV-2",
    service: index === 0 ? "checkout-api" : "worker",
    status: "new",
    // Nine hours apart, so the 30 findings span 11 days: 19 in the last 7.
    postedAt: new Date(now - index * 9 * 3_600_000).toISOString(),
  }));
  const state = {
    findings,
    settings: {
      enabled: options.setUp ?? true,
      setupComplete: options.setUp ?? true,
      slack: null as null | { integrationAccountId: string; channelId: string },
      repositoryIds: [] as string[],
      minimumSeverity: "SEV-3" as "SEV-1" | "SEV-2" | "SEV-3",
      dailyInvestigationCap: null as number | null,
      dismissalCooldownHours: 24,
      skippedServices: [] as string[],
      notes: "",
      limits: { dailyInvestigationCap: 50 },
    },
    // The next settings save fails with this error, like a server rejecting it.
    failNextSave: null as string | null,
    // How long each settings save takes, to change settings while one runs.
    saveDelayMs: 0,
    billing: {
      enabled: true,
      plan: null as null | { id: string; name: string; price: number; cancelsAtPeriodEnd: boolean },
      included: 0,
      used: 0,
      remaining: 0,
      resetsAt: Date.parse("2026-12-01T00:00:00Z") as number | null,
      plans: signalPlans,
    },
    // Where checkout sends the member; null when the plan changes in place.
    checkoutUrl: "/signal/setup/plan?checkout=success" as string | null,
    writes: [] as Array<{ method: string; path: string; body: unknown }>,
  };
  return state;
}

async function workspace(page: Page, options: { enabled?: boolean; signal?: ReturnType<typeof fakeSignal> } = {}) {
  const enabled = options.enabled ?? true;
  const signal = options.signal ?? fakeSignal();
  const now = new Date().toISOString();
  const organization = { id: "11111111-1111-4111-8111-111111111111", name: "Acme", slug: "acme", createdAt: now, logo: null, metadata: null };
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/auth/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const userId = "22222222-2222-4222-8222-222222222222";
    const json = path.endsWith("/get-session") ? {
      session: { id: "session-id", userId, activeOrganizationId: organization.id, token: "session-token", expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: now, updatedAt: now },
      user: { id: userId, name: "Ada Lovelace", email: "ada@example.com", emailVerified: true, image: null, createdAt: now, updatedAt: now },
    } : path.endsWith("/organization/list") ? [organization]
      : path.endsWith("/organization/get-full-organization") ? organization : null;
    return route.fulfill({ json });
  });
  await page.route("**/api/context", (route) => route.fulfill({ json: { capabilities: enabled ? ["signal"] : [] } }));
  await page.route("**/api/legacy-account-redirect", (route) => route.fulfill({ json: { redirect: false } }));
  await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: [] } }));
  await page.route("**/api/billing", (route) => route.fulfill({ json: { configured: false, enabled: false } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { integrations: [
    { id: "sentry", name: "Sentry", description: "", state: "connected", accountCount: 1, resourceCount: 12, connectUrl: "/api/integrations/sentry/start", configurationUrl: null, accounts: [{ id: "33333333-3333-4333-8333-333333333333", displayName: "acme", status: "connected", resourceCount: 12, updatedAt: now, details: { organizationSlug: "acme" } }] },
    { id: "datadog", name: "Datadog", description: "", state: "available", accountCount: 0, resourceCount: 0, connectUrl: "/api/integrations/datadog/connect", configurationUrl: null },
    { id: "github", name: "GitHub", description: "", state: "connected", accountCount: 1, resourceCount: 0, connectUrl: "/api/integrations/github/start", configurationUrl: null },
    { id: "slack", name: "Slack", description: "", state: "connected", accountCount: 1, resourceCount: 2, connectUrl: "/api/integrations/slack/start", configurationUrl: null, accounts: [{ id: "slack-account", displayName: "Acme", status: "connected", resourceCount: 2, updatedAt: now }] },
    { id: "linear", name: "Linear", description: "", state: "available", accountCount: 0, resourceCount: 0, connectUrl: "/api/integrations/linear/start", configurationUrl: null },
  ] } }));
  await page.route("**/api/agents/options", (route) => route.fulfill({ json: {
    accounts: [],
    resources: [
      { id: "r1", integrationAccountId: "slack-account", kind: "slack_channel", externalId: "C01", displayName: "incidents" },
      { id: "r2", integrationAccountId: "slack-account", kind: "slack_channel", externalId: "C02", displayName: "engineering" },
    ],
    repositories: [
      { id: "repo-api", integrationAccountId: "gh", fullName: "acme/api", defaultBranch: "main", private: true },
      { id: "repo-web", integrationAccountId: "gh", fullName: "acme/web", defaultBranch: "main", private: true },
    ],
    secrets: [],
  } }));
  await page.route("**/api/signal/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/signal", "");
    const body = request.postData() ? JSON.parse(request.postData()!) as Record<string, unknown> : null;
    if (request.method() !== "GET") signal.writes.push({ method: request.method(), path, body });
    if (path === "/settings") {
      if (request.method() === "PUT") {
        if (signal.saveDelayMs) await new Promise((resolve) => setTimeout(resolve, signal.saveDelayMs));
        if (signal.failNextSave) {
          const error = signal.failNextSave;
          signal.failNextSave = null;
          return route.fulfill({ status: 400, json: { error } });
        }
        if (body!.enabled && !body!.slack) return route.fulfill({ status: 400, json: { error: "Choose a Slack channel before turning Signal on." } });
        Object.assign(signal.settings, body);
        if (signal.settings.enabled) signal.settings.setupComplete = true;
      }
      return route.fulfill({ json: signal.settings });
    }
    if (path === "/billing") return route.fulfill({ json: signal.billing });
    if (path === "/billing/checkout") {
      // Stands in for Stripe: the plan is recorded and checkout returns.
      const plan = signalPlans.find((candidate) => candidate.id === body!.planId)!;
      Object.assign(signal.billing, {
        plan: { id: plan.id, name: plan.name, price: plan.price, cancelsAtPeriodEnd: false },
        included: plan.included,
        remaining: plan.included,
      });
      return route.fulfill({ json: { url: signal.checkoutUrl } });
    }
    if (path === "/billing/portal") return route.fulfill({ json: { url: "/settings" } });
    if (path === "/findings") {
      const days = Number(url.searchParams.get("days"));
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const since = Date.now() - days * 86_400_000;
      const matches = signal.findings.filter((f) => f.title.toLowerCase().includes(search) && Date.parse(f.postedAt) >= since);
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return route.fulfill({ json: { total: matches.length, findings: matches.slice(offset, offset + limit) } });
    }
    const detail = /^\/findings\/(SIG-\d+)(?:\/(status|copied))?$/u.exec(path);
    if (detail) {
      const finding = signal.findings.find((f) => f.id === detail[1]);
      if (!finding) return route.fulfill({ status: 404, json: { error: "Finding not found." } });
      if (detail[2] === "status") finding.status = body!.status as FakeFinding["status"];
      if (detail[2] === "copied") finding.status = "accepted";
      return route.fulfill({ json: detail[2] ? { status: finding.status } : {
        ...finding, impact: "11 customers could not pay.", affectedUsers: 11, affectedRequests: 18,
        rootCause: "The retry budget is longer than the gateway deadline.", suggestedFix: "Lower the client timeout.",
        evidence: [{ kind: "traces", title: "Checkout 504s", detail: "18 spans with status 504 in the last 2 hours" }],
        prompt: `Investigate Superlog finding ${finding.id} and propose a fix with tests.`,
      } });
    }
    if (path === "/usage") {
      const days = Number(url.searchParams.get("days"));
      const daily = Array.from({ length: days }, (_, index) => {
        const date = new Date(Date.now() - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
        return { date, total: index === days - 1 ? 4 : index % 3, accepted: index === days - 1 ? 3 : 0 };
      });
      return route.fulfill({ json: { daily } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return signal;
}
test.use({ viewport: { width: 1440, height: 1040 } });

test("requires the capability for direct Signal routes", async ({ page }) => {
  await workspace(page, { enabled: false });
  await page.goto("/signal/findings/SIG-042");
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Findings" })).toHaveCount(0);
});

test("shows only setup until it is complete, then the rest of Signal", async ({ page }) => {
  await workspace(page, { signal: fakeSignal(30, { setUp: false }) });
  const navigation = page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link");
  await page.goto("/signal/findings");
  await expect(page).toHaveURL(/\/signal\/setup$/u);
  await expect(navigation).toHaveText(["Setup", "Settings"]);
  await page.goto("/signal/usage");
  await expect(page).toHaveURL(/\/signal\/setup$/u);
  await page.goto("/settings/workspace");
  await expect(navigation).toHaveText(["Setup", "Settings"]);
});

test("sets up Signal with the workspace's real connections and turns it on after checkout", async ({ page }) => {
  const signal = await workspace(page, { signal: fakeSignal(30, { setUp: false }) });
  await page.goto("/app");
  await expect(page).toHaveURL(/\/signal\/setup$/);
  const navigation = page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link");
  await expect(navigation).toHaveText(["Setup", "Settings"]);
  await expect(page.getByRole("button", { name: "Manage Sentry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Datadog" })).toBeEnabled();
  await page.screenshot({ path: "test-results/signal-setup.png" });
  await page.getByRole("button", { name: "Connect Datadog" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/telemetry\/datadog$/u);
  await expect(page.getByRole("heading", { name: "Connect Datadog" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Datadog" })).toBeDisabled();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/telemetry$/u);
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await next.click();
  await expect(page).toHaveURL(/\/signal\/setup\/code$/);
  await next.click();
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeVisible();
  await page.getByLabel("Search repositories").fill("api");
  await page.getByRole("checkbox", { name: "acme / api" }).check();
  await page.getByLabel("Search repositories").fill("");
  await expect(page.getByText("1 selected")).toBeVisible();
  await next.click();
  await expect(page).toHaveURL(/\/signal\/setup\/slack$/);
  await expect(next).toBeDisabled();
  await page.getByLabel("Findings channel").fill("eng");
  await expect(page.getByRole("option", { name: "# incidents" })).toHaveCount(0);
  await page.getByRole("option", { name: "# engineering" }).click();
  await expect(page.getByLabel("Findings channel")).toHaveValue("engineering");
  await next.click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/plan$/);
  await expect(page.getByRole("heading", { name: "Choose your plan" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Pro" })).toContainText("$100 / month");
  await expect(page.getByRole("article", { name: "Pro" })).toContainText("Up to 50 investigated findings");
  await expect(page.getByRole("article", { name: "Max" })).toContainText("$2 per finding");
  await expect(page.getByRole("button", { name: "Turn on Signal" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/signal-plan.png" });
  await page.getByRole("button", { name: "Choose Max ($200)" }).click();
  await expect(page).toHaveURL(/\/signal\/findings$/);
  await expect(navigation).toHaveText(["Findings", "Usage", "Setup", "Settings"]);
  expect(signal.settings).toMatchObject({ enabled: true, setupComplete: true, slack: { integrationAccountId: "slack-account", channelId: "C02" }, repositoryIds: ["repo-api"] });
  // Saves send the settings that can change, never the read-only ones.
  expect(signal.writes[0]!.body).toEqual({
    enabled: false, slack: null, repositoryIds: ["repo-api"], minimumSeverity: "SEV-3", dailyInvestigationCap: null,
    dismissalCooldownHours: 24, skippedServices: [], notes: "",
  });
  expect(signal.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
    "PUT /settings", "PUT /settings", "POST /billing/checkout", "PUT /settings",
  ]);
  expect(signal.writes[2]!.body).toEqual({ planId: "signal_max" });
});

test("shows the current plan and its findings", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  Object.assign(signal.billing, {
    plan: { id: "signal_pro", name: "Pro", price: 100, cancelsAtPeriodEnd: false }, included: 50, used: 12, remaining: 38,
  });
  await workspace(page, { signal });
  await page.goto("/signal/setup/plan");
  const current = page.getByRole("group", { name: "Current plan" });
  await expect(current).toContainText("Pro $100 / month · up to 50 findings");
  await expect(current).toContainText("12 of 50 findings used · resets 1 Dec");
  await expect(page.getByRole("meter", { name: "Findings used this month" })).toHaveAttribute("aria-valuenow", "12");
  await expect(page.getByRole("button", { name: "Switch to Max ($200)" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Manage billing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Turn (on|off) Signal/u })).toHaveCount(0);
  await page.screenshot({ path: "../.context/impl-setup-plan.png" });
});

test("turns Signal off and sends the workspace to a plan to turn it on again", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  await workspace(page, { signal });
  await page.goto("/signal/setup");
  await expect(page).toHaveURL(/\/signal\/setup\/general$/u);
  await expect(page.getByText("Signal is on", { exact: true })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Investigate and post findings" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Signal is off", { exact: true })).toBeVisible();
  await expect(page.locator(".signalSaveStatus")).toHaveText("Saved");
  expect(signal.settings.enabled).toBe(false);
  // The plan ended, so turning on again starts with choosing one.
  await expect(page.getByText("Choose a plan to turn Signal on.")).toBeVisible();
  await toggle.click();
  await expect(page).toHaveURL(/\/signal\/setup\/plan$/u);
  await expect(page.getByRole("button", { name: "Choose Pro ($100)" })).toBeEnabled();
  expect(signal.settings.enabled).toBe(false);
});

test("turns Signal on from settings with a plan, and shows why it cannot without a channel", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.enabled = false;
  Object.assign(signal.billing, { plan: { id: "signal_pro", name: "Pro", price: 100, cancelsAtPeriodEnd: false }, included: 50, remaining: 50 });
  await workspace(page, { signal });
  await page.goto("/signal/setup/general");
  const toggle = page.getByRole("switch", { name: "Investigate and post findings" });
  await toggle.click();
  await expect(page.getByRole("alert")).toHaveText("Choose a Slack channel before turning Signal on.");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  await page.reload();
  await toggle.click();
  await expect(page.getByText("Signal is on", { exact: true })).toBeVisible();
  expect(signal.settings.enabled).toBe(true);
});

test("switching plans leaves Signal off when it was turned off", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.enabled = false;
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  Object.assign(signal.billing, {
    plan: { id: "signal_pro", name: "Pro", price: 100, cancelsAtPeriodEnd: false }, included: 50, used: 3, remaining: 47,
  });
  signal.checkoutUrl = null;
  await workspace(page, { signal });
  await page.goto("/signal/setup/plan");
  await page.getByRole("button", { name: "Switch to Max ($200)" }).click();
  await expect(page.getByRole("group", { name: "Current plan" })).toContainText("Max $200 / month");
  await expect(page.getByRole("button", { name: "Switch to Pro ($100)" })).toBeVisible();
  await expect(page).toHaveURL(/\/signal\/setup\/plan$/);
  expect(signal.settings.enabled).toBe(false);
});

test("confirms a plan when checkout comes back to settings", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  await workspace(page, { signal });
  await page.goto("/signal/setup/plan");
  await page.getByRole("button", { name: "Choose Pro ($100)" }).click();
  await expect(page.getByRole("group", { name: "Current plan" })).toContainText("Pro $100 / month");
  await expect(page).toHaveURL(/\/signal\/setup\/plan$/u);
  expect(signal.writes.map((write) => `${write.method} ${write.path}`)).toEqual(["POST /billing/checkout"]);
});

test("waits for findings to reset once a plan's findings are used", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  Object.assign(signal.billing, {
    plan: { id: "signal_pro", name: "Pro", price: 100, cancelsAtPeriodEnd: false }, included: 50, used: 50, remaining: 0,
  });
  await workspace(page, { signal });
  await page.goto("/signal/setup/plan");
  await expect(page.getByText("Signal starts investigating again on 1 Dec.")).toBeVisible();
});

test("saves each general setting as it changes", async ({ page }) => {
  const signal = fakeSignal();
  Object.assign(signal.settings, {
    slack: { integrationAccountId: "slack-account", channelId: "C02" },
    skippedServices: ["load-tester"],
    notes: "Checkout matters most.",
  });
  await workspace(page, { signal });
  await page.goto("/signal/setup/general");
  const bodies = () => signal.writes.map((write) => write.body as Record<string, unknown>);

  await page.getByRole("radiogroup", { name: "Post findings from" }).getByRole("radio", { name: "SEV-2 and up" }).click();
  await expect(page.locator(".signalSaveStatus")).toHaveText("Saved");
  expect(bodies().at(-1)).toMatchObject({ minimumSeverity: "SEV-2", enabled: true, slack: { integrationAccountId: "slack-account", channelId: "C02" } });
  expect(bodies().at(-1)).not.toHaveProperty("limits");

  const cap = page.getByLabel("Investigations per day");
  await expect(cap).toHaveValue("50");
  await expect(cap.locator("option")).toHaveText(["Up to 10", "Up to 25", "Up to 50"]);
  await cap.selectOption("25");
  await expect.poll(() => signal.settings.dailyInvestigationCap).toBe(25);
  // The most allowed is stored as no cap.
  await cap.selectOption("50");
  await expect.poll(() => signal.settings.dailyInvestigationCap).toBeNull();

  await page.getByLabel("Look again at dismissed problems").selectOption({ label: "After 7 days" });
  await expect.poll(() => signal.settings.dismissalCooldownHours).toBe(168);

  await page.getByRole("button", { name: "Add service" }).click();
  const service = page.getByLabel("Service to skip");
  await service.fill("bad name");
  await service.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Use letters, numbers");
  await service.fill("staging-*");
  await service.press("Enter");
  await expect.poll(() => signal.settings.skippedServices).toEqual(["load-tester", "staging-*"]);
  await page.getByRole("button", { name: "Stop skipping load-tester" }).click();
  await expect.poll(() => signal.settings.skippedServices).toEqual(["staging-*"]);

  const notes = page.getByLabel("Notes for Signal");
  const saveNotes = page.getByRole("button", { name: "Save", exact: true });
  await expect(notes).toHaveValue("Checkout matters most.");
  await expect(saveNotes).toBeDisabled();
  await notes.fill("Checkout matters most. Ignore 404s from crawlers.");
  await saveNotes.click();
  await expect.poll(() => signal.settings.notes).toBe("Checkout matters most. Ignore 404s from crawlers.");
  await expect(saveNotes).toBeDisabled();
  await expect(page.locator(".signalSaveStatus")).toHaveText("Saved");
  await page.getByLabel("Service to skip").press("Escape");
  await expect(page.getByRole("button", { name: "Add service" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.screenshot({ path: "../.context/impl-setup-general.png" });
});

test("undoes a setting whose save fails and shows why", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  await workspace(page, { signal });
  await page.goto("/signal/setup/general");
  signal.failNextSave = "dailyInvestigationCap must be at most 50.";
  await page.getByLabel("Investigations per day").selectOption("10");
  await expect(page.getByRole("alert")).toHaveText("dailyInvestigationCap must be at most 50.");
  await expect(page.getByLabel("Investigations per day")).toHaveValue("50");
  expect(signal.settings.dailyInvestigationCap).toBeNull();
});

test("a failed save undoes only its own change, not a later one", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  await workspace(page, { signal });
  await page.goto("/signal/setup/general");
  signal.saveDelayMs = 500;
  signal.failNextSave = "Could not save the cap.";
  const cap = page.getByLabel("Investigations per day");
  await cap.selectOption("25");
  await cap.selectOption("10");
  await expect(page.getByRole("alert")).toHaveText("Could not save the cap.");
  await expect.poll(() => signal.settings.dailyInvestigationCap).toBe(10);
  await expect(cap).toHaveValue("10");
  expect(signal.writes.map((write) => (write.body as { dailyInvestigationCap: number | null }).dailyInvestigationCap)).toEqual([25, 10]);
});

test("fits a long list of skipped services in a narrow desktop window", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.skippedServices = ["load-tester", "staging-*", "a-rather-long-service-name-for-batch-imports", "worker"];
  await workspace(page, { signal });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto("/signal/setup/general");
  await page.getByRole("button", { name: "Add service" }).click();
  const card = await page.getByRole("region", { name: "Focus" }).locator(".signalSettingsCard").boundingBox();
  for (const box of await page.locator(".signalSkipped, .signalChip, .signalChipForm").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right))) {
    expect(box).toBeLessThanOrEqual(card!.x + card!.width);
  }
});

test("manages sources from settings", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  signal.settings.repositoryIds = ["repo-api"];
  await workspace(page, { signal });
  await page.goto("/signal/setup/sources");
  await expect(page.getByRole("group", { name: "Sentry" })).toContainText("acme · 12 projects");
  await expect(page.getByRole("group", { name: "GitHub" })).toContainText("1 of 2 repositories");
  await expect(page.getByRole("group", { name: "GitHub" })).toContainText("acme/api");
  await expect(page.getByRole("region", { name: "Context" })).toContainText("No context is connected.");
  await page.screenshot({ path: "../.context/impl-setup-sources.png" });

  await page.getByRole("button", { name: "Edit repositories" }).click();
  await page.getByRole("checkbox", { name: "acme / web" }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("group", { name: "GitHub" })).toContainText("2 of 2 repositories");
  await expect.poll(() => signal.settings.repositoryIds).toEqual(["repo-api", "repo-web"]);

  await page.getByRole("button", { name: "Manage Sentry" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/sources\/sentry$/u);
  await expect(page.getByRole("heading", { name: "Connected to the acme organization" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Setup sections" }).getByRole("link", { name: "Sources" })).toHaveClass(/active/u);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/sources\/sentry\/connect$/u);
  await expect(page.getByRole("heading", { name: "Connect Sentry" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/sources$/u);

  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/sources\/telemetry$/u);
  await expect(page.getByRole("button", { name: "Manage Sentry" })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect Datadog" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/sources\/datadog$/u);
  await expect(page.getByRole("heading", { name: "Connect Datadog" })).toBeVisible();

  await page.goto("/signal/setup/sources/context");
  await expect(page.getByRole("button", { name: "Connect Linear" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Connect Jira" })).toBeDisabled();
});

test("lists OpenTelemetry when its services lookup fails, so its page shows the failure", async ({ page }) => {
  await workspace(page);
  const lookups: string[] = [];
  await page.route("**/api/telemetry/services?**", (route) => {
    lookups.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: "ClickHouse is unavailable" } });
  });
  // Another source's page does not look up services.
  await page.goto("/signal/setup/sources/sentry");
  await expect(page.getByRole("heading", { name: "Connected to the acme organization" })).toBeVisible();
  expect(lookups).toEqual([]);

  await page.goto("/signal/setup/sources");
  await expect(page.getByRole("group", { name: "OpenTelemetry" })).toContainText("Could not check for data");
  await page.getByRole("button", { name: "Manage OpenTelemetry" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/sources\/otel$/u);
  await expect(page.getByRole("heading", { name: "Could not check for data" })).toBeVisible();
  await page.goto("/signal/setup/sources/telemetry");
  await expect(page.getByRole("button", { name: "Connect Datadog" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect OpenTelemetry" })).toHaveCount(0);
});

test("sends links from before setup was complete to the matching settings", async ({ page }) => {
  await workspace(page);
  await page.goto("/signal/setup/telemetry/sentry");
  await expect(page).toHaveURL(/\/signal\/setup\/sources\/sentry$/u);
  await page.goto("/signal/setup/context?status=error&integration=linear");
  await expect(page).toHaveURL(/\/signal\/setup\/sources\?status=error&integration=linear$/u);
  await expect(page.getByRole("alert")).toContainText("Could not connect Linear.");
  await page.goto("/signal/setup/slack");
  await expect(page).toHaveURL(/\/signal\/setup\/notifications$/u);
  await page.goto("/signal/setup/nonsense?status=error&integration=linear");
  await expect(page).toHaveURL(/\/signal\/setup\/general\?status=error&integration=linear$/u);
  await page.goto("/signal/setup/plan/extra?checkout=success");
  await expect(page).toHaveURL(/\/signal\/setup\/plan\?checkout=success$/u);
});

test("changes where findings are posted", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.slack = { integrationAccountId: "slack-account", channelId: "C02" };
  await workspace(page, { signal });
  await page.goto("/signal/setup/notifications");
  await expect(page.getByRole("group", { name: "Slack" })).toContainText("Acme");
  await expect(page.getByRole("button", { name: "Change workspace" })).toHaveCount(0);
  const channel = page.getByLabel("Findings channel");
  await expect(channel).toHaveValue("engineering");
  await page.getByRole("button", { name: "Show Slack channels" }).click();
  await expect(page.getByRole("option")).toHaveText(["# engineering", "# incidents"]);
  await page.getByRole("option", { name: "# incidents" }).click();
  await expect.poll(() => signal.settings.slack).toEqual({ integrationAccountId: "slack-account", channelId: "C01" });
  expect(signal.writes.at(-1)!.body).toMatchObject({ enabled: true, slack: { integrationAccountId: "slack-account", channelId: "C01" } });
  // Managing Slack opens the workspace's integrations, like setup does.
  await page.getByRole("button", { name: "Manage Slack" }).click();
  await expect(page).toHaveURL(/\/settings$/u);
});

test("explains an empty channel list in setup and in settings", async ({ page }) => {
  const signal = fakeSignal(30, { setUp: false });
  await workspace(page, { signal });
  await page.route("**/api/agents/options", (route) => route.fulfill({ json: {
    accounts: [{ id: "slack-account", provider: "slack", displayName: "Acme" }], resources: [], repositories: [], secrets: [],
  } }));
  await page.goto("/signal/setup/slack");
  await expect(page.getByLabel("Findings channel")).toBeDisabled();
  await expect(page.getByLabel("Findings channel")).toHaveAttribute("placeholder", "No channels found");
  await expect(page.getByText("Invite Responder to a channel, then reload this page.")).toBeVisible();
  Object.assign(signal.settings, { enabled: true, setupComplete: true });
  await page.goto("/signal/setup/notifications");
  await expect(page.getByText("Invite Responder to a channel, then reload this page.")).toBeVisible();
});

test("manages a connected source and disconnects it after confirming", async ({ page }) => {
  await workspace(page, { signal: fakeSignal(30, { setUp: false }) });
  const removals: string[] = [];
  await page.route("**/api/integrations/*/accounts/*", (route) => {
    removals.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ json: { removed: true } });
  });
  await page.goto("/signal/setup/telemetry");
  await page.getByRole("button", { name: "Manage Sentry" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/telemetry\/sentry$/u);
  await expect(page.getByRole("heading", { name: "Connected to the acme organization" })).toBeVisible();
  await expect(page.getByText("12 projects")).toBeVisible();
  await page.screenshot({ path: "test-results/signal-manage.png" });

  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/telemetry\/sentry\/connect$/u);
  await expect(page.getByRole("heading", { name: "Connect Sentry" })).toBeVisible();
  await page.goBack();

  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Disconnect Sentry?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Disconnect Sentry", exact: true })).toBeVisible();
  expect(removals).toEqual([]);

  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Sentry" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/telemetry$/u);
  expect(removals).toEqual(["DELETE /api/integrations/sentry/accounts/33333333-3333-4333-8333-333333333333"]);
});

test("shows why a connection cannot be removed", async ({ page }) => {
  await workspace(page, { signal: fakeSignal(30, { setUp: false }) });
  await page.route("**/api/integrations/*/accounts/*", (route) => route.fulfill({
    status: 409,
    json: { error: 'This connection is used by the automation "Nightly triage". Remove it from that automation first.' },
  }));
  await page.goto("/signal/setup/telemetry/sentry");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Sentry" }).click();
  await expect(page.getByRole("alert")).toHaveText(/used by the automation "Nightly triage"/u);
  await expect(page).toHaveURL(/\/signal\/setup\/telemetry\/sentry$/u);
});

test("tells a failed services lookup apart from no OpenTelemetry data", async ({ page }) => {
  await workspace(page, { signal: fakeSignal(30, { setUp: false }) });
  // Every lookup fails until "Try again", including setup's own.
  let retried = false;
  await page.route("**/api/telemetry/services?**", (route) => !retried
    ? route.fulfill({ status: 500, json: { error: "ClickHouse is unavailable" } })
    : route.fulfill({ json: { services: ["checkout-api"] } }));
  // The page loads its services on any step, not only telemetry.
  await page.goto("/signal/setup/context/otel");
  await expect(page.getByRole("heading", { name: "Could not check for data" })).toBeVisible();
  await expect(page.getByText("No data in the last 24 hours")).toHaveCount(0);
  retried = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Receiving data from 1 service" })).toBeVisible();
});

test("opens findings once setup is complete, also with Signal turned off", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.enabled = false;
  await workspace(page, { signal });
  await page.goto("/app");
  await expect(page).toHaveURL(/\/signal\/findings$/);
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link")).toHaveText(["Findings", "Usage", "Setup", "Settings"]);
});

test("keeps a failed settings lookup on Signal's home with a retry", async ({ page }) => {
  await workspace(page);
  // Fails until the test retries; development runs effects twice.
  let available = false;
  await page.route("**/api/signal/settings", (route) => (available
    ? route.fulfill({ json: { enabled: true, slack: null, repositoryIds: [] } })
    : route.fulfill({ status: 503, json: { error: "This service is unavailable. Try again shortly." } })));
  await page.goto("/app");
  await expect(page.getByRole("alert")).toHaveText("Could not load Signal. Try again shortly.");
  await expect(page).toHaveURL(/\/signal$/u);
  available = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(/\/signal\/findings$/u);
});

test("searches, pages, and acts on findings", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const signal = await workspace(page);
  await page.goto("/signal/findings");
  await expect(page.getByText("Showing 25 of 30 findings")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await page.screenshot({ path: "test-results/signal-findings.png" });
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Showing 30 of 30 findings")).toBeVisible();
  await page.getByLabel("Date range").selectOption("7");
  await expect(page.getByText("Showing 19 of 19 findings")).toBeVisible();
  await page.getByLabel("Search findings").fill("nonsense");
  await expect(page.getByRole("heading", { name: "No matching findings" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("link", { name: "Checkout requests time out after the payment client retry change", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();
  await expect(page.getByText("18 spans with status 504")).toBeVisible();
  await page.getByRole("button", { name: "Copy prompt" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Prompt copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("SIG-030");
  await expect(page.locator(".signalProperties")).toContainText("Accepted");
  await page.getByRole("button", { name: "Mark as irrelevant" }).click();
  await expect(page.locator(".signalProperties")).toContainText("Irrelevant");
  await page.getByRole("button", { name: "Restore finding" }).click();
  await expect(page.locator(".signalProperties")).toContainText("New");
  await page.screenshot({ path: "test-results/signal-detail.png" });
  expect(signal.writes.map((write) => [write.path, write.body])).toEqual([
    ["/findings/SIG-030/copied", null],
    ["/findings/SIG-030/status", { status: "irrelevant" }],
    ["/findings/SIG-030/status", { status: "new" }],
  ]);
});

test("shows usage for the chosen period", async ({ page }) => {
  await workspace(page);
  await page.goto("/signal/usage");
  await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
  await page.getByRole("button", { name: /: 4, 3 accepted$/u }).focus();
  await expect(page.getByRole("tooltip")).toContainText("Accepted");
  await page.screenshot({ path: "test-results/signal-usage.png" });
  await page.getByLabel("Date range").selectOption("30");
  await expect(page.getByRole("button", { name: /: \d+, \d+ accepted$/u })).toHaveCount(30);
});

test("account menu matches sidebar and supports keyboard navigation", async ({ page }) => {
  await workspace(page);
  await page.goto("/signal/findings");
  const trigger = page.getByRole("button", { name: /Open Acme and account menu/ });
  await trigger.click();
  const active = page.getByRole("menuitem", { name: /Acme/ });
  await expect(active).toBeFocused();
  await expect(active).toHaveCSS("border-radius", "4px");
  await expect(active).toHaveCSS("font-size", "13px");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Workspace settings" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("keeps the last chart tooltip inside a narrow desktop chart", async ({ page }) => {
  await workspace(page);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/signal/usage");
  const chart = page.locator(".signalChart").first();
  await chart.getByRole("button").last().focus();
  const tooltip = await chart.getByRole("tooltip").boundingBox();
  const canvas = await chart.locator(".signalChartCanvas").boundingBox();
  expect(tooltip).not.toBeNull();
  expect(canvas).not.toBeNull();
  expect(tooltip!.x).toBeGreaterThanOrEqual(canvas!.x);
  expect(tooltip!.x + tooltip!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width + 1);
});

test("connects OpenTelemetry with one agent prompt and waits for data", async ({ page }) => {
  await workspace(page, { signal: fakeSignal(30, { setUp: false }) });
  let services: string[] = [];
  const signals = new Set<string>();
  await page.route("**/api/telemetry/ingest-keys", (route) => route.fulfill({ json: {
    key: { id: "key-1", name: "Signal setup", prefix: "sl_ingest_tes", createdAt: new Date().toISOString(), lastUsedAt: null },
    token: "sl_ingest_test",
  } }));
  await page.route("**/api/telemetry/services?**", (route) => {
    const signal = new URL(route.request().url()).searchParams.get("signal");
    if (signal) signals.add(signal);
    return route.fulfill({ json: { services: signal === "metrics" ? [] : services } });
  });
  await page.goto("/signal/setup/telemetry/otel");
  await expect(page.getByRole("heading", { name: "Connect OpenTelemetry" })).toBeVisible();
  const prompt = page.locator(".signalPromptBody");
  await expect(prompt).toContainText("keep every existing exporter working");
  await expect(prompt).toContainText("x-api-key=sl_ingest_test");
  await page.getByRole("radio", { name: "No, or I don't know" }).click();
  await expect(prompt).toContainText("Instrument this project with OpenTelemetry");
  await expect(page.getByText("Waiting for data")).toBeVisible();
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeDisabled();
  await page.screenshot({ path: "test-results/signal-otel.png" });

  services = ["checkout-api"];
  await expect(page.getByText("Receiving data")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("cell", { name: "checkout-api" })).toBeVisible();
  expect([...signals].sort()).toEqual(expect.arrayContaining(["logs", "metrics", "traces"]));
  await expect(prompt).toHaveCount(0);
  await next.click();
  await expect(page).toHaveURL(/\/signal\/setup\/telemetry$/u);

  await page.getByRole("button", { name: "Manage OpenTelemetry" }).click();
  await expect(page.getByRole("heading", { name: "Receiving data from 1 service" })).toBeVisible();
  await expect(page.getByText("/api/ingest")).toBeVisible();
  await page.getByRole("button", { name: "Show prompt" }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/telemetry\/otel\/connect$/u);
  await expect(page.getByRole("heading", { name: "Connect OpenTelemetry" })).toBeVisible();
});

test("connects AWS with one launch and finishes when the stack reports back", async ({ page, context }) => {
  await workspace(page, { signal: fakeSignal(30, { setUp: false }) });
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { integrations: [
    { id: "aws", name: "AWS", description: "", state: "available", accountCount: 0, resourceCount: 0, connectUrl: "/api/integrations/aws/connect", configurationUrl: null },
  ] } }));
  let launchBody: unknown = null;
  await page.route("**/api/integrations/aws/connect", (route) => {
    launchBody = route.request().postDataJSON();
    return route.fulfill({ json: { accountId: "setup-1", cloudFormationUrl: "https://eu-west-3.console.aws.amazon.com/cloudformation/home", template: "" } });
  });
  let setup: Record<string, string> = { status: "waiting" };
  await page.route("**/api/integrations/aws/setup/setup-1", (route) => route.fulfill({ json: setup }));
  await context.route("https://eu-west-3.console.aws.amazon.com/**", (route) => route.fulfill({ body: "AWS" }));

  await page.goto("/signal/setup/telemetry/aws");
  await expect(page.getByRole("heading", { name: "Connect AWS CloudWatch" })).toBeVisible();
  const popup = context.waitForEvent("page");
  await page.getByRole("button", { name: "Launch stack in AWS" }).click();
  await expect((await popup)).toHaveURL(/eu-west-3\.console\.aws\.amazon\.com/u);
  expect(launchBody).toEqual({ returnTo: "/signal/setup/telemetry" });
  await expect(page.getByRole("heading", { name: "Waiting for the stack" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();

  setup = { status: "connected", awsAccountId: "123456789012", roleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole" };
  await expect(page.getByRole("heading", { name: "AWS account 123456789012 connected" })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "test-results/signal-aws-connected.png" });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/signal\/setup\/telemetry$/u);
});

test("Signal workspace settings do not load unrelated product APIs", async ({ page }) => {
  await workspace(page);
  await page.route("**/api/auth/organization/get-active-member", (route) => route.fulfill({ json: { id: "member-id", role: "admin" } }));
  const unrelated: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(billing|telemetry|sandbox|integrations\/github\/pull-request-author)/.test(path)) unrelated.push(path);
  });
  await page.goto("/settings/workspace");
  await expect(page.getByRole("heading", { name: "Invite a teammate" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link")).toHaveText(["Workspace"]);
  await expect(page.getByRole("group", { name: "Workspace", exact: true }).getByRole("link")).toHaveText(["Settings"]);
  expect(unrelated).toEqual([]);
});

test("mobile setup, detail, and navigation fit the viewport", async ({ page }) => {
  await workspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/signal/setup");
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/signal-mobile.png" });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Findings" }).click();
  await expect(page.locator(".workspaceSurface")).not.toHaveAttribute("inert");
  await page.getByRole("link", { name: "Checkout requests time out after the payment client retry change", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
