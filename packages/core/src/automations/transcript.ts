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
  target: string;
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

// A follow-up or test chat message from a workspace member.
export interface AutomationUserMessageEventData {
  authorId: string;
  authorName: string;
  text: string;
}

export const automationUserMessageMaxLength = 20_000;
