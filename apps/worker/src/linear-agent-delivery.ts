import { sendLinearAgentActivity } from "@responder/core/db/linear-agent-sessions";
import { linearAgentSessionAttribute } from "@responder/core/integrations/linear-agent";
import type { InvestigationRequest } from "@responder/core/investigations/input";

export const linearProgressIntervalMs = 3_000;
export const linearFailureMessage =
  "Responder could not finish this request. Try again, or check the request in Responder.";

export interface LinearAgentDelivery {
  fail(): Promise<void>;
  progress(detail: string, options?: { force?: boolean }): Promise<void>;
  respond(markdown: string): Promise<void>;
}

// Linear requests reply in their agent session instead of a Slack thread.
// Progress is an ephemeral thought, so each update replaces the previous one.
// The reply or error uses the investigation ID as its activity ID, so a
// redelivered job does not post it twice.
export function linearAgentDelivery(input: {
  investigationId: string;
  organizationId: string;
  request: InvestigationRequest;
  now?: () => number;
  send?: typeof sendLinearAgentActivity;
}): LinearAgentDelivery | null {
  if (input.request.provider !== "linear") return null;
  const agentSessionId = input.request.attributes?.[linearAgentSessionAttribute];
  const integrationAccountId = input.request.attributes?.integrationAccountId;
  if (
    typeof agentSessionId !== "string" ||
    typeof integrationAccountId !== "string"
  ) {
    return null;
  }
  const send = input.send ?? sendLinearAgentActivity;
  const now = input.now ?? Date.now;
  const target = {
    agentSessionId,
    integrationAccountId,
    organizationId: input.organizationId,
  };
  let lastDetail: string | null = null;
  let lastProgressAt = 0;
  return {
    async progress(detail, options) {
      if (detail === lastDetail) return;
      const at = now();
      if (!options?.force && at - lastProgressAt < linearProgressIntervalMs) {
        return;
      }
      lastDetail = detail;
      lastProgressAt = at;
      await send({
        ...target,
        content: { type: "thought", body: detail },
        ephemeral: true,
      });
    },
    async respond(markdown) {
      await send({
        ...target,
        content: { type: "response", body: markdown },
        id: input.investigationId,
      });
    },
    async fail() {
      await send({
        ...target,
        content: { type: "error", body: linearFailureMessage },
        id: input.investigationId,
      });
    },
  };
}
