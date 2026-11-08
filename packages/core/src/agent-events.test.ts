import { Wakeshift } from "@wakeshift/sdk";
import { createTestClient, type TestClient } from "@wakeshift/sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineAgentEvents,
  logWatchSubscribers,
  notifyLogsMatched,
  notifyAlertChanged,
  notifyAutomationRunFinished,
  notifyErrorIssueOpened,
  notifyIntegrationConnected,
  notifySyntheticCheckChanged,
  setAgentEvents,
} from "./agent-events.js";

const runId = "51515151-5151-4151-8151-515151515151";
const organizationId = "15151515-1515-4515-8515-151515151515";

describe("agent events", () => {
  let wake: TestClient;

  beforeEach(() => {
    wake = createTestClient({ app: "Superlog" });
    setAgentEvents(defineAgentEvents(wake));
  });

  afterEach(async () => {
    await wake.close();
    setAgentEvents(undefined);
    vi.restoreAllMocks();
  });

  it("emits a finished run once per turn", async () => {
    const completedAt = new Date("2026-11-08T10:00:00.000Z");

    await notifyAutomationRunFinished({ completedAt, runId, status: "failed" });
    await notifyAutomationRunFinished({ completedAt, runId, status: "failed" });

    expect(wake.emits).toEqual([{
      args: { run: runId },
      event: "automation_run.finished",
      id: `automation-run-${runId}-${completedAt.getTime()}`,
      payload: { status: "failed" },
      text: `Automation run ${runId} failed.`,
    }]);
  });

  it("emits whether a connection attempt connected", async () => {
    const attemptId = "71717171-7171-4171-8171-717171717171";

    await notifyIntegrationConnected({ attemptId, connected: false, organizationId, provider: "sentry" });
    await notifyIntegrationConnected({ attemptId, connected: true, organizationId, provider: "sentry" });

    expect(wake.emits.map(({ args, payload, text }) => ({ args, payload, text }))).toEqual([
      { args: { provider: "sentry", workspace: organizationId }, payload: { status: "not_connected" }, text: "sentry is not connected." },
      { args: { provider: "sentry", workspace: organizationId }, payload: { status: "connected" }, text: "sentry is connected." },
    ]);
  });

  it("shortens error titles from telemetry", async () => {
    await notifyErrorIssueOpened({
      issueId: "81818181-8181-4181-8181-818181818181",
      openedAt: new Date("2026-11-08T10:00:00.000Z"),
      organizationId,
      service: "checkout",
      title: "x".repeat(500),
      transition: "regressed",
    });

    const [emit] = wake.emits;
    expect(emit).toMatchObject({ args: { workspace: organizationId }, event: "error_issue.opened" });
    expect((emit!.payload as { title: string }).title).toHaveLength(160);
    expect(emit!.text).toBe("A regressed error issue opened in checkout.");
  });

  it("emits alert and synthetic check changes per episode", async () => {
    const alertId = "61616161-6161-4161-8161-616161616161";
    const checkId = "91919191-9191-4191-8191-919191919191";
    const episodeId = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";

    await notifyAlertChanged({ alertId, episodeId, group: "", name: "Checkout errors", state: "firing", value: 42 });
    await notifySyntheticCheckChanged({ checkId, episodeId, name: "Homepage", reason: "Status was 503", state: "failing" });

    expect(wake.emits.map(({ args, id, text }) => ({ args, id, text }))).toEqual([
      { args: { alert: alertId }, id: `alert-episode-${episodeId}-firing`, text: "Alert \"Checkout errors\" is firing at 42." },
      { args: { check: checkId }, id: `synthetic-check-episode-${episodeId}-failing`, text: "Synthetic check \"Homepage\" is failing: Status was 503." },
    ]);
  });

  it("sends nothing without a key", async () => {
    const fetch = vi.fn();
    setAgentEvents(defineAgentEvents(new Wakeshift({ fetch, key: "" })));

    await notifyAutomationRunFinished({ completedAt: new Date(), runId, status: "succeeded" });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs a failed emit instead of throwing", async () => {
    const events = defineAgentEvents(createTestClient());
    vi.spyOn(events.automationRunFinished, "emit").mockRejectedValue(new Error("unreachable"));
    setAgentEvents(events);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(notifyAutomationRunFinished({ completedAt: new Date(), runId, status: "succeeded" })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent_event_emit_failed"));
  });

  it("emits a log watch's batch with a short newest line, and reports who it reached", async () => {
    const watchId = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
    const since = new Date("2026-11-08T11:59:00.000Z");
    const until = new Date("2026-11-08T11:59:30.000Z");

    const result = await notifyLogsMatched({
      count: 20,
      latest: { body: `payment\n  failed ${"x".repeat(300)}`, service: "checkout", severity: "ERROR" },
      more: true,
      since,
      until,
      watchId,
    });

    expect(result).toEqual({ matched: 0 });
    const [emit] = wake.emits;
    expect(emit).toMatchObject({
      args: { watch: watchId },
      event: "logs.matched",
      id: `log-watch-${watchId}-${until.getTime()}`,
      payload: { count: 20, more: true, since: since.toISOString(), until: until.toISOString() },
    });
    const body = (emit!.payload as { latest: { body: string } }).latest.body;
    expect(body).toHaveLength(100);
    expect(body.startsWith("payment failed x")).toBe(true);
    expect(emit!.text).toBe("20+ new logs matched the watch in checkout.");
    expect(await logWatchSubscribers(watchId)).toBe(0);
  });

  it("never splits a character when it shortens a log line", async () => {
    await notifyLogsMatched({
      count: 1,
      latest: { body: "🔥".repeat(150), service: "checkout", severity: "ERROR" },
      more: false,
      since: new Date("2026-11-08T11:59:00.000Z"),
      until: new Date("2026-11-08T11:59:30.000Z"),
      watchId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
    });

    const body = (wake.emits[0]!.payload as { latest: { body: string } }).latest.body;
    expect(Array.from(body)).toHaveLength(100);
    expect(body).toBe(`${"🔥".repeat(99)}…`);
  });
});
