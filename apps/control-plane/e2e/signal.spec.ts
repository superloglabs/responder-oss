import { expect, test, type Page } from "@playwright/test";

interface FakeFinding {
  id: string; title: string; subtitle: string; severity: "SEV-1" | "SEV-2"; service: string;
  status: "new" | "accepted" | "irrelevant"; postedAt: string;
}

// A Signal API in memory: findings, usage, and settings, with every write recorded.
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
    },
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
    { id: "sentry", name: "Sentry", description: "", state: "connected", accountCount: 1, resourceCount: 0, connectUrl: "/api/integrations/sentry/start", configurationUrl: null },
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
        Object.assign(signal.settings, body);
        if (signal.settings.enabled) signal.settings.setupComplete = true;
      }
      return route.fulfill({ json: signal.settings });
    }
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

test("sets up Signal with the workspace's real connections and turns it on", async ({ page }) => {
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
  await page.getByLabel("Findings channel").selectOption("C02");
  await next.click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Turn on Signal" }).click();
  await expect(page).toHaveURL(/\/signal\/findings$/);
  await expect(navigation).toHaveText(["Setup", "Findings", "Usage", "Settings"]);
  expect(signal.settings).toEqual({ enabled: true, setupComplete: true, slack: { integrationAccountId: "slack-account", channelId: "C02" }, repositoryIds: ["repo-api"] });
  expect(signal.writes.map((write) => write.method)).toEqual(["PUT", "PUT", "PUT"]);
});

test("opens findings once setup is complete, also with Signal turned off", async ({ page }) => {
  const signal = fakeSignal();
  signal.settings.enabled = false;
  await workspace(page, { signal });
  await page.goto("/app");
  await expect(page).toHaveURL(/\/signal\/findings$/);
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link")).toHaveText(["Setup", "Findings", "Usage", "Settings"]);
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
  await expect(page.getByRole("button", { name: "Connect Datadog" })).toBeVisible();
  await page.screenshot({ path: "test-results/signal-mobile.png" });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Findings" }).click();
  await expect(page.locator(".workspaceSurface")).not.toHaveAttribute("inert");
  await page.getByRole("link", { name: "Checkout requests time out after the payment client retry change", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
