import { createTestClient, type TestClient } from "@wakeshift/sdk/testing";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineAgentEvents, setAgentEvents } from "../../../../packages/core/src/agent-events.js";
import { managementMcpRoutes } from "./mcp.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const automationId = "41414141-4141-4141-8141-414141414141";
const runId = "51515151-5151-4151-8151-515151515151";
const alertId = "61616161-6161-4161-8161-616161616161";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  createLogWatch: vi.fn(),
  findAlert: vi.fn(),
  getAutomation: vi.fn(),
  queueFollowUp: vi.fn(),
  queueRun: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/api-keys.js", () => ({
  authenticateApiKey: vi.fn().mockResolvedValue({
    apiKeyId: "31313131-3131-4131-8131-313131313131",
    organizationId: "15151515-1515-4515-8515-151515151515",
    role: "member",
    user: { email: "ash@example.com", id: "21212121-2121-4121-8121-212121212121", name: "Ash" },
  }),
  listApiKeys: vi.fn().mockResolvedValue([]),
  revokeApiKey: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/oauth-access-tokens.js", () => ({
  authenticateOAuthAccessToken: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  listEnabledOrganizationCapabilities: vi.fn().mockResolvedValue(["automations", "telemetry", "alerts"]),
  organizationHasCapability: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../../../packages/core/src/db/automations.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getAutomation: mocks.getAutomation,
}));
vi.mock("../../../../packages/core/src/db/telemetry-alerts.js", async (importOriginal) => ({
  ...(await importOriginal()),
  findTelemetryAlert: mocks.findAlert,
}));
vi.mock("../../../../packages/core/src/db/log-watches.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createLogWatch: mocks.createLogWatch,
}));
vi.mock("../../../../packages/core/src/telemetry/client.js", () => ({
  getTelemetryClient: vi.fn().mockReturnValue({}),
}));
vi.mock("../../../../packages/core/src/analytics.js", () => ({
  captureAnalyticsEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../automations/queue.js", () => ({
  queueAutomationRun: mocks.queueRun,
  queueAutomationRunFollowUp: mocks.queueFollowUp,
}));

const app = new Hono().route("/api/mcp", managementMcpRoutes);

async function mcp(method: string, params?: Record<string, unknown>) {
  const response = await app.request("/api/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "claude-code/2.1.0 (external, cli)",
    },
    method: "POST",
  });
  return (await response.json() as { result: Record<string, unknown> }).result;
}

function callTool(name: string, args: Record<string, unknown> = {}) {
  return mcp("tools/call", { arguments: args, name }) as Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
}

describe("agent wakeups", () => {
  let wake: TestClient;

  beforeEach(() => {
    wake = createTestClient({ app: "Superlog" });
    setAgentEvents(defineAgentEvents(wake));
  });

  afterEach(async () => {
    await wake.close();
    setAgentEvents(undefined);
    vi.clearAllMocks();
  });

  it("lists the tools that subscribe with Wakeshift's arguments, and leaves the others alone", async () => {
    const { tools } = await mcp("tools/list") as {
      tools: Array<{ description: string; inputSchema: { properties?: Record<string, unknown> }; name: string }>;
    };
    const tool = (name: string) => tools.find((item) => item.name === name)!;

    for (const name of ["start_automation_run", "send_automation_run_message", "start_integration_connection",
      "watch_alert", "watch_error_issues", "watch_synthetic_check"]) {
      expect(tool(name).inputSchema.properties).toHaveProperty("session_key");
    }
    expect(tool("list_automations").inputSchema.properties ?? {}).not.toHaveProperty("session_key");
    expect(tools.map((item) => item.name)).toContain("unsubscribe_events");
  });

  it("subscribes a started run's conversation to the run finishing", async () => {
    mocks.getAutomation.mockResolvedValue({ enabled: true, id: automationId });
    mocks.queueRun.mockResolvedValue({ duplicate: false, runId });

    const result = await callTool("start_automation_run", { automationId });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ duplicate: false, runId });
    expect(wake.subscriptions).toEqual([expect.objectContaining({
      args: { run: runId },
      event: "automation_run.finished",
      once: true,
      tool: "start_automation_run",
      user: userId,
    })]);
    expect(wake.subscriptions[0]!.replay).toBeGreaterThan(0);
  });

  it("subscribes a follow-up's conversation to the next turn, without replaying the last one", async () => {
    mocks.queueFollowUp.mockResolvedValue({ jobId: "job" });

    await callTool("send_automation_run_message", { message: "And the logs?", runId: runId.toUpperCase() });

    expect(wake.subscriptions).toEqual([expect.objectContaining({
      args: { run: runId },
      event: "automation_run.finished",
      once: true,
    })]);
    expect(wake.subscriptions[0]!.replay).toBeUndefined();
  });

  it("subscribes nothing when the tool fails", async () => {
    mocks.getAutomation.mockResolvedValue({ enabled: false, id: automationId });

    const result = await callTool("start_automation_run", { automationId });

    expect(result.isError).toBe(true);
    expect(wake.subscriptions).toEqual([]);
    expect(mocks.queueRun).not.toHaveBeenCalled();
  });

  it("returns the run when Wakeshift can't be reached", async () => {
    mocks.getAutomation.mockResolvedValue({ enabled: true, id: automationId });
    mocks.queueRun.mockResolvedValue({ duplicate: false, runId });
    wake.failNext("subscribe", "unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await callTool("start_automation_run", { automationId });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ runId });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mcp_wakeup_subscribe_failed"));
    warn.mockRestore();
  });

  it("watches an alert the workspace owns, by its stored ID", async () => {
    mocks.findAlert.mockResolvedValue({ id: alertId, name: "Checkout errors" });

    const result = await callTool("watch_alert", { alertId: alertId.toUpperCase(), once: true });

    expect(JSON.parse(result.content[0]!.text)).toEqual({ alert: { id: alertId, name: "Checkout errors" } });
    expect(mocks.findAlert).toHaveBeenCalledWith(organizationId, alertId.toUpperCase());
    expect(wake.subscriptions).toEqual([expect.objectContaining({
      args: { alert: alertId },
      event: "alert.changed",
      once: true,
    })]);
  });

  it("refuses to watch another workspace's alert", async () => {
    mocks.findAlert.mockResolvedValue(null);

    const result = await callTool("watch_alert", { alertId });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: "alert_not_found" });
    expect(wake.subscriptions).toEqual([]);
  });

  it("watches the caller's workspace for error issues until told to stop", async () => {
    await callTool("watch_error_issues");

    expect(wake.subscriptions).toEqual([expect.objectContaining({
      args: { workspace: organizationId },
      event: "error_issue.opened",
      once: false,
    })]);
  });

  it("starts a log watch and subscribes its conversation for as long as it runs", async () => {
    const watchId = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
    mocks.createLogWatch.mockResolvedValue({ expiresAt: new Date("2026-11-08T13:00:00.000Z"), id: watchId });

    const result = await callTool("watch_logs", { minutes: 30, service: "checkout", severity: "ERROR" });

    expect(JSON.parse(result.content[0]!.text)).toEqual({ watch: { expiresAt: "2026-11-08T13:00:00.000Z", id: watchId } });
    expect(mocks.createLogWatch).toHaveBeenCalledWith(expect.objectContaining({
      filters: { service: "checkout", severity: "ERROR" }, minutes: 30, organizationId, userId,
    }));
    expect(wake.subscriptions).toEqual([expect.objectContaining({
      args: { watch: watchId }, event: "logs.matched", once: false, ttl: 1_800,
    })]);
  });

  it("refuses a log watch without filters, or past the workspace's limit", async () => {
    const unfiltered = await callTool("watch_logs", {});
    expect(JSON.parse(unfiltered.content[0]!.text)).toMatchObject({ code: "filter_required" });

    const { LogWatchLimitError } = await import("../../../../packages/core/src/db/log-watches.js");
    mocks.createLogWatch.mockRejectedValue(new LogWatchLimitError());
    const full = await callTool("watch_logs", { search: "timeout" });
    expect(full.isError).toBe(true);
    expect(JSON.parse(full.content[0]!.text)).toMatchObject({ code: "too_many_log_watches" });
    expect(wake.subscriptions).toEqual([]);
  });
});
