import type { AgentEvents, ToolCall } from "../../../../packages/core/src/agent-events.js";
import { automationRunInWorkspace } from "../../../../packages/core/src/db/automations.js";
import { endLogWatch } from "../../../../packages/core/src/db/log-watches.js";
import type { ManagementContext } from "./operation.js";

// The MCP tools that subscribe the calling conversation to an event, through
// Wakeshift, and the events each one subscribes to.
export function wakingTools(events: AgentEvents) {
  return {
    send_automation_run_message: [events.automationRunFinished],
    start_automation_run: [events.automationRunFinished],
    start_integration_connection: [events.integrationConnected],
    watch_alert: [events.alertChanged],
    watch_error_issues: [events.errorIssueOpened],
    watch_logs: [events.logsMatched],
    watch_synthetic_check: [events.syntheticCheckChanged],
  };
}

type Body = Record<string, unknown>;

function nested(body: Body, key: string): Body {
  const value = body[key];
  return typeof value === "object" && value !== null ? value as Body : {};
}

// Subscribes before the tool's work starts, for work that may finish at once
// under an ID that already had occurrences, so replay can't cover the gap.
// The caller must be able to see the ID first. If the work then fails, the
// tool's error ends the subscription.
export async function subscribeCallerFirst(input: {
  call: ToolCall;
  context: ManagementContext;
  events: AgentEvents;
  input: Body;
  tool: string;
}): Promise<void> {
  const { call, context, events } = input;
  if (!("subscribe" in call) || input.tool !== "send_automation_run_message") return;
  const runId = String(input.input.runId ?? "").toLowerCase();
  // A follow-up starts a new turn of a run the caller can see.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(runId)) return;
  if (!(await automationRunInWorkspace(context.organizationId, runId))) return;
  await call.subscribe(events.automationRunFinished, { run: runId }, { once: true });
}

// Subscribes after the tool's work succeeded, with the IDs it read or made.
// The operation has already checked that the caller can see them.
//
// A run's ID exists only once the run is queued, so its subscription replays
// a finish from the last ten minutes. Arguments that repeat (a provider
// connected again) never replay, or an earlier occurrence would end the
// subscription at once.
export async function subscribeCaller(input: {
  body: Body;
  call: ToolCall;
  context: ManagementContext;
  events: AgentEvents;
  input: Body;
  tool: string;
}): Promise<void> {
  const { body, call, context, events } = input;
  if (!("subscribe" in call)) return;
  const once = input.input.once === true;
  switch (input.tool) {
    case "start_automation_run":
      await call.subscribe(events.automationRunFinished, { run: String(body.runId) }, { once: true, replay: "10m" });
      return;
    case "start_integration_connection":
      // A recovered connection or a secure setup page has nothing to wait for.
      if (body.status !== "awaiting_consent") return;
      await call.subscribe(
        events.integrationConnected,
        { provider: String(body.provider), workspace: context.organizationId },
        { once: true, ttl: "1h" },
      );
      return;
    case "watch_error_issues":
      await call.subscribe(events.errorIssueOpened, { workspace: context.organizationId }, { once });
      return;
    case "watch_alert":
      await call.subscribe(events.alertChanged, { alert: String(nested(body, "alert").id) }, { once });
      return;
    case "watch_logs": {
      // The watch ID is new, so replaying finds only this watch's batches;
      // the subscription lasts as long as the watch. A watch nobody can hear
      // ends at once, so it doesn't hold one of the workspace's slots.
      const watchId = String(nested(body, "watch").id);
      const minutes = Number(input.input.minutes ?? 60);
      let subscription: Awaited<ReturnType<typeof call.subscribe>>;
      try {
        subscription = await call.subscribe(events.logsMatched, { watch: watchId }, { replay: "10m", ttl: `${minutes}m` });
      } catch (error) {
        await endLogWatch(watchId, "unsubscribed", new Date());
        throw error;
      }
      if (subscription.state === "unavailable") {
        await endLogWatch(watchId, "unsubscribed", new Date());
        throw new Error(`log watch subscription unavailable: ${subscription.reason}`);
      }
      return;
    }
    case "watch_synthetic_check":
      await call.subscribe(events.syntheticCheckChanged, { check: String(nested(body, "check").id) }, { once });
      return;
  }
}
