import { conductorHandoffUrl } from "@responder/core/ide-handoff";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import { getAutomationNotificationAccount } from "@responder/core/db/automations";
import {
  createDevRevTicketComment,
  parseDevRevCredentials,
} from "@responder/core/integrations/devrev";
import { z } from "zod";
import {
  automationNotificationMessage,
  automationRunUrl,
  type AutomationRunOutcome,
} from "./automation-notifications.js";

const devrevTriggerSchema = z.object({
  attributes: z.object({
    integrationAccountId: z.uuid(),
    ticketId: z.string().min(1),
  }),
  provider: z.literal("devrev"),
});

export interface DevRevTicket {
  integrationAccountId: string;
  ticketId: string;
}

// The DevRev ticket that started a run, if one did.
export function devrevTicketOf(triggerInput: Record<string, unknown>): DevRevTicket | null {
  const parsed = devrevTriggerSchema.safeParse(triggerInput);
  return parsed.success ? parsed.data.attributes : null;
}

export interface AutomationDevRevDependencies {
  comment: typeof createDevRevTicketComment;
  getAccount: typeof getAutomationNotificationAccount;
}

const defaultDependencies: AutomationDevRevDependencies = {
  comment: (input) => createDevRevTicketComment(input),
  getAccount: getAutomationNotificationAccount,
};

// Posts a finished run's result as an internal comment on its ticket.
export async function commentAutomationRunOnDevRevTicket(input: {
  automationId: string;
  automationName: string;
  environment: NodeJS.ProcessEnv;
  organizationId: string;
  outcome: AutomationRunOutcome;
  runId: string;
  ticket: DevRevTicket;
}, dependencies: AutomationDevRevDependencies = defaultDependencies): Promise<void> {
  const account = await dependencies.getAccount({
    integrationAccountId: input.ticket.integrationAccountId,
    organizationId: input.organizationId,
    provider: "devrev",
  });
  if (!account) throw new Error("The DevRev connection is unavailable");
  const { token } = parseDevRevCredentials(decryptCredentials(account.encryptedCredentials));
  const { markdown } = automationNotificationMessage({
    automationName: input.automationName,
    outcome: input.outcome,
    runUrl: automationRunUrl(input),
  });
  const sourceUrl = automationRunUrl(input);
  const handoff = sourceUrl ? `\n\n[Continue in Conductor](${conductorHandoffUrl({ kind: "continue", sourceUrl, context: markdown })})` : "";
  await dependencies.comment({ body: markdown + handoff, ticketId: input.ticket.ticketId, token });
}
