import { Wakeshift } from "@wakeshift/sdk";
import { z } from "zod";

export type { ToolCall, ToolCallSubscribe } from "@wakeshift/sdk";

// Events that wake the agents using Superlog's MCP server, through Wakeshift.
// A tool subscribes the conversation calling it, and the API or the worker
// emits when the thing happens. Without WAKESHIFT_KEY the client is off:
// tools work as before and emits send nothing.
//
// Every event is open only to Superlog's own tools, which check workspace
// access before they subscribe. Argument values are workspace, run, alert,
// and check UUIDs, which already fit Wakeshift's routing values.

export function defineAgentEvents(wake: Wakeshift) {
  return {
    wake,
    automationRunFinished: wake.defineEvent("automation_run.finished", {
      description: "An automation run, or a follow-up turn of it, finished: it succeeded, failed, or was cancelled.",
      args: z.object({ run: z.string() }),
      payload: z.object({ status: z.enum(["succeeded", "failed", "cancelled"]) }),
      text: ({ status }, { run }) => `Automation run ${run} ${status}.`,
    }),
    integrationConnected: wake.defineEvent("integration.connected", {
      description: "The person returned from an integration's consent page: the integration is connected, or it is not.",
      args: z.object({ workspace: z.string(), provider: z.string() }),
      payload: z.object({ status: z.enum(["connected", "not_connected"]) }),
      text: ({ status }, { provider }) =>
        status === "connected" ? `${provider} is connected.` : `${provider} is not connected.`,
    }),
    errorIssueOpened: wake.defineEvent("error_issue.opened", {
      description: "An error issue opened in the workspace: a new error, or a resolved one that came back.",
      args: z.object({ workspace: z.string() }),
      payload: z.object({
        issue: z.string(),
        service: z.string().nullable(),
        title: z.string(),
        transition: z.enum(["new", "regressed"]),
      }),
      // Titles come from the workspace's telemetry, so they stay in the
      // payload, out of the line the agent reads first.
      text: ({ service, transition }) =>
        `${transition === "new" ? "A new" : "A regressed"} error issue opened${service ? ` in ${service}` : ""}.`,
    }),
    alertChanged: wake.defineEvent("alert.changed", {
      description: "An alert started firing, or recovered.",
      args: z.object({ alert: z.string() }),
      payload: z.object({
        group: z.string(),
        name: z.string(),
        state: z.enum(["firing", "resolved"]),
        value: z.number(),
      }),
      text: ({ group, name, state, value }) =>
        `Alert "${name}"${group ? ` (${group})` : ""} ${state === "firing" ? "is firing" : "recovered"} at ${value}.`,
    }),
    syntheticCheckChanged: wake.defineEvent("synthetic_check.changed", {
      description: "A synthetic check started failing, or recovered.",
      args: z.object({ check: z.string() }),
      payload: z.object({
        name: z.string(),
        reason: z.string().nullable(),
        state: z.enum(["failing", "resolved"]),
      }),
      text: ({ name, reason, state }) =>
        state === "failing" ? `Synthetic check "${name}" is failing: ${reason ?? "the run failed"}.` : `Synthetic check "${name}" recovered.`,
    }),
    logsMatched: wake.defineEvent("logs.matched", {
      description: "New logs matched a log watch: their count, the time window they are in, and the newest line.",
      args: z.object({ watch: z.string() }),
      payload: z.object({
        count: z.number().int(),
        latest: z.object({ body: z.string(), service: z.string(), severity: z.string() }),
        more: z.boolean().describe("More logs matched than count."),
        since: z.string(),
        until: z.string(),
      }),
      // Log lines come from the workspace's telemetry, so the newest one stays
      // in the payload, out of the line the agent reads first.
      text: ({ count, latest, more }) =>
        `${count}${more ? "+" : ""} new log${count === 1 && !more ? "" : "s"} matched the watch${latest.service ? ` in ${latest.service}` : ""}.`,
    }),
  };
}

export type AgentEvents = ReturnType<typeof defineAgentEvents>;

let current: AgentEvents | undefined;

// Created on first use, so the key is read after the process loaded its
// environment.
export function agentEvents(): AgentEvents {
  current ??= defineAgentEvents(new Wakeshift());
  return current;
}

// Tests replace the events with ones on Wakeshift's offline test client.
export function setAgentEvents(events: AgentEvents | undefined): void {
  current = events;
}

const textLimit = 160;

// Cuts by code points, so a character outside the Basic Multilingual Plane
// is never split.
function truncate(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : value;
}

function short(value: string): string {
  return truncate(value, textLimit);
}

// Waking agents never fails or delays the work it reports: the emit runs in
// the background, and a failure is only logged.
function send(event: string, emit: (events: AgentEvents) => Promise<unknown>): Promise<void> {
  const events = agentEvents();
  if (!events.wake.enabled) return Promise.resolve();
  return emit(events).then(
    () => undefined,
    (error: unknown) => {
      console.warn(JSON.stringify({
        error: error instanceof Error ? error.name : typeof error,
        event: "agent_event_emit_failed",
        name: event,
      }));
    },
  );
}

export function notifyAutomationRunFinished(input: {
  completedAt: Date;
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
}): Promise<void> {
  return send("automation_run.finished", (events) => events.automationRunFinished.emit(
    { run: input.runId },
    { status: input.status },
    { id: `automation-run-${input.runId}-${input.completedAt.getTime()}` },
  ));
}

export function notifyIntegrationConnected(input: {
  attemptId: string;
  connected: boolean;
  organizationId: string;
  provider: string;
}): Promise<void> {
  const status = input.connected ? "connected" : "not_connected";
  return send("integration.connected", (events) => events.integrationConnected.emit(
    { provider: input.provider, workspace: input.organizationId },
    { status },
    { id: `integration-${input.attemptId}-${status}` },
  ));
}

export function notifyErrorIssueOpened(input: {
  issueId: string;
  openedAt: Date;
  organizationId: string;
  service: string | null;
  title: string;
  transition: "new" | "regressed";
}): Promise<void> {
  return send("error_issue.opened", (events) => events.errorIssueOpened.emit(
    { workspace: input.organizationId },
    {
      issue: input.issueId,
      service: input.service ? short(input.service) : null,
      title: short(input.title),
      transition: input.transition,
    },
    { id: `error-issue-${input.issueId}-${input.transition}-${input.openedAt.getTime()}` },
  ));
}

export function notifyAlertChanged(input: {
  alertId: string;
  episodeId: string;
  group: string;
  name: string;
  state: "firing" | "resolved";
  value: number;
}): Promise<void> {
  return send("alert.changed", (events) => events.alertChanged.emit(
    { alert: input.alertId },
    { group: short(input.group), name: short(input.name), state: input.state, value: input.value },
    { id: `alert-episode-${input.episodeId}-${input.state}` },
  ));
}

export function notifySyntheticCheckChanged(input: {
  checkId: string;
  episodeId: string;
  name: string;
  reason: string | null;
  state: "failing" | "resolved";
}): Promise<void> {
  return send("synthetic_check.changed", (events) => events.syntheticCheckChanged.emit(
    { check: input.checkId },
    { name: short(input.name), reason: input.reason ? short(input.reason) : null, state: input.state },
    { id: `synthetic-check-episode-${input.episodeId}-${input.state}` },
  ));
}

const logBodyLimit = 100;

// Emits one batch of a log watch's matches. Unlike the other events, the
// worker needs Wakeshift's answer: no matched subscription means nobody is
// listening any more. Null when Wakeshift is off or the emit failed.
export async function notifyLogsMatched(input: {
  count: number;
  latest: { body: string; service: string; severity: string };
  more: boolean;
  since: Date;
  until: Date;
  watchId: string;
}): Promise<{ matched: number } | null> {
  const events = agentEvents();
  if (!events.wake.enabled) return null;
  const body = input.latest.body.replace(/\s+/gu, " ").trim();
  try {
    const emitted = await events.logsMatched.emit(
      { watch: input.watchId },
      {
        count: input.count,
        latest: {
          body: truncate(body, logBodyLimit),
          service: short(input.latest.service),
          severity: input.latest.severity.slice(0, 20),
        },
        more: input.more,
        since: input.since.toISOString(),
        until: input.until.toISOString(),
      },
      { id: `log-watch-${input.watchId}-${input.until.getTime()}` },
    );
    return { matched: emitted.matched };
  } catch (error) {
    console.warn(JSON.stringify({
      error: error instanceof Error ? error.name : typeof error,
      event: "agent_event_emit_failed",
      name: "logs.matched",
    }));
    return null;
  }
}

// How many conversations still listen to a log watch. Null when Wakeshift is
// off or could not answer.
export async function logWatchSubscribers(watchId: string): Promise<number | null> {
  const events = agentEvents();
  if (!events.wake.enabled) return null;
  try {
    return (await events.logsMatched.status({ watch: watchId })).subscriptions;
  } catch {
    return null;
  }
}
