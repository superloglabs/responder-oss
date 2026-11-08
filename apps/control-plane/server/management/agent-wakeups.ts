import type { AgentEvents, ToolCall } from "../../../../packages/core/src/agent-events.js";
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
    watch_synthetic_check: [events.syntheticCheckChanged],
  };
}

type Body = Record<string, unknown>;

function nested(body: Body, key: string): Body {
  const value = body[key];
  return typeof value === "object" && value !== null ? value as Body : {};
}

// Subscribes after the tool's work succeeded, with the IDs it read or made.
// The operation has already checked that the caller can see them.
//
// A run's ID exists only once the run is queued, so its subscription replays
// a finish from the last ten minutes. Arguments that repeat (a run's next
// turn, a provider connected again) never replay, or an earlier occurrence
// would end the subscription at once.
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
    case "send_automation_run_message":
      await call.subscribe(events.automationRunFinished, { run: String(input.input.runId).toLowerCase() }, { once: true });
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
    case "watch_synthetic_check":
      await call.subscribe(events.syntheticCheckChanged, { check: String(nested(body, "check").id) }, { once });
      return;
  }
}
