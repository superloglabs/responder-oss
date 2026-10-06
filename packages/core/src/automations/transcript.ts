// A run transcript normalized from the harness event stream. The worker stores
// it in a `transcript` run event after each turn; the run page renders it.

export type AutomationToolAction =
  | "edit"
  | "fetch"
  | "query"
  | "read"
  | "run"
  | "search"
  | "other";

interface AutomationTranscriptItemBase {
  // When the worker first saw the item, in epoch milliseconds.
  observedAt?: number;
  // The sub-agent that produced the item; absent for the main agent.
  subagentId?: string;
}

export interface AutomationTranscriptMessage extends AutomationTranscriptItemBase {
  kind: "message";
  text: string;
}

// A reasoning summary (Codex, OpenCode) or thinking block (Claude).
export interface AutomationTranscriptReasoning extends AutomationTranscriptItemBase {
  kind: "reasoning";
  text: string;
}

export interface AutomationTranscriptTool extends AutomationTranscriptItemBase {
  action: AutomationToolAction;
  // Only OpenCode reports tool timing.
  durationMs?: number;
  kind: "tool";
  // Context server name for MCP tools, for example "sentry".
  provider?: string;
  status: "failed" | "succeeded";
  // Set when the tool started a sub-agent (Claude's Agent tool). The target
  // is its description, and items with this `subagentId` are its work.
  subagent?: AutomationTranscriptSubagent;
  target: string;
}

export interface AutomationTranscriptSubagent {
  // False while the sub-agent works, including in the background.
  finished: boolean;
  id: string;
  // The sub-agent type, for example "general-purpose".
  type?: string;
}

export type AutomationTranscriptItem =
  | AutomationTranscriptMessage
  | AutomationTranscriptReasoning
  | AutomationTranscriptTool;

export interface AutomationTranscriptEventData {
  items: AutomationTranscriptItem[];
  // When the harness started, in epoch milliseconds.
  startedAt?: number;
  truncated: boolean;
}

// A follow-up or test chat message from a workspace member, a reply in the
// Slack thread that started the run, a press of a button the agent added to a
// Slack message, or a review on a pull request the run opened.
export interface AutomationUserMessageEventData {
  authorId: string;
  authorName: string;
  // The Slack or GitHub event, so a redelivered event is stored once.
  externalEventId?: string;
  githubReview?: GitHubPullRequestReviewMessage;
  slackButton?: AutomationSlackButtonPress;
  source?: "github" | "slack";
  text: string;
}

export interface GitHubPullRequestReviewMessage {
  pullRequestNumber: number;
  repository: string;
  reviewUrl: string;
}

export interface AutomationSlackButtonPress {
  channelId: string;
  // The Slack connection that posted the message.
  integrationAccountId: string;
  label: string;
  messageTimestamp: string;
  // The message's thread, where the run answers.
  threadTimestamp: string;
}

export const automationUserMessageMaxLength = 20_000;
