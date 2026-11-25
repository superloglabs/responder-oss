import type { AutomationUserMessageEventData } from "@responder/core/automations/transcript";

// What an automation run may publish. Only a run a workspace member started
// from Responder, its API, or its MCP server is trusted. Every other trigger
// carries text that someone outside the workspace may have written: alerts,
// error and Sentry issues, webhook requests, tickets, pull requests, channel
// messages, and scheduled runs that read the workspace's telemetry.
export interface AutomationPullRequestPolicy {
  allowDependencyChanges: boolean;
  // The workspace asks a member before a pull request from such a run is
  // opened, and nobody has answered in this turn.
  awaitingApproval: boolean;
  untrustedTrigger: boolean;
}

interface ConversationEvent {
  data: unknown;
  type: string;
}

export function untrustedAutomationTrigger(triggerInput: Record<string, unknown>): boolean {
  return triggerInput.provider !== "manual";
}

// Whether a workspace member answered in this turn: a follow-up from the run
// page, the API, or the MCP server, or a press of one of the run's Slack
// buttons by a member of the connected Slack team. Slack replies, presses
// from people in other teams, and GitHub reviews do not count.
export function memberApprovedThisTurn(conversation: readonly ConversationEvent[]): boolean {
  const lastTranscript = conversation.findLastIndex((event) => event.type === "transcript");
  return conversation.slice(lastTranscript + 1).some((event) => {
    if (event.type !== "user_message") return false;
    const message = event.data as AutomationUserMessageEventData;
    if (message.slackButton) return message.slackButton.pressedByTeamMember === true;
    return message.source === undefined;
  });
}

export function automationPullRequestPolicy(input: {
  allowDependencyChanges: boolean;
  conversation: readonly ConversationEvent[];
  requireApproval: boolean;
  triggerInput: Record<string, unknown>;
}): AutomationPullRequestPolicy {
  const untrustedTrigger = untrustedAutomationTrigger(input.triggerInput);
  return {
    allowDependencyChanges: input.allowDependencyChanges,
    awaitingApproval: input.requireApproval && untrustedTrigger && !memberApprovedThisTurn(input.conversation),
    untrustedTrigger,
  };
}
