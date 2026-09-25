import type {
  AutomationToolAction,
  AutomationTranscriptEventData,
  AutomationTranscriptReasoning,
  AutomationTranscriptTool,
  AutomationUserMessageEventData,
} from "../../../packages/core/src/automations/transcript";
import type { AutomationRunDetail } from "./automations-api";
import { providerDisplayName } from "./components/provider-glyphs";

// Reasoning and tool calls between two messages.
export type AutomationActivityStep = AutomationTranscriptReasoning | AutomationTranscriptTool;

export type AutomationRunEntry =
  | { kind: "trigger"; key: string }
  | { authorName: string; createdAt: string; key: string; kind: "user"; text: string }
  | { key: string; kind: "message"; text: string }
  | { durationMs: number | null; key: string; kind: "activity"; steps: AutomationActivityStep[] }
  | { key: string; kind: "pullRequest"; number: string | null; repository: string | null; title: string | null; url: string }
  | { key: string; kind: "notice"; text: string }
  | { key: string; kind: "failure"; text: string };

function isTranscript(data: unknown): data is AutomationTranscriptEventData {
  return typeof data === "object" && data !== null && Array.isArray((data as { items?: unknown }).items);
}

function isUserMessage(data: unknown): data is AutomationUserMessageEventData {
  return typeof data === "object" && data !== null && typeof (data as { text?: unknown }).text === "string";
}

function stringField(data: Record<string, unknown> | null, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value ? value : null;
}

// Orders a run's events as a chat. A test chat opens with the member's
// message; other runs open with the trigger that started them.
export function automationRunTimeline(run: AutomationRunDetail): AutomationRunEntry[] {
  const entries: AutomationRunEntry[] = [];
  if (run.events[0]?.type !== "user_message") entries.push({ key: "trigger", kind: "trigger" });
  for (const event of run.events) {
    const key = String(event.id);
    if (event.type === "user_message" && isUserMessage(event.data)) {
      entries.push({ authorName: event.data.authorName, createdAt: event.createdAt, key, kind: "user", text: event.data.text });
    } else if (event.type === "transcript" && isTranscript(event.data)) {
      // Items carry the time the worker first saw them, so an activity lasts
      // from the item before it to its last step.
      let previousAt = event.data.startedAt;
      let activityStartedAt: number | undefined;
      event.data.items.forEach((item, index) => {
        const previous = entries.at(-1);
        if (item.kind === "message") {
          // An activity lasts until the message that follows it.
          if (previous?.kind === "activity" && previous.key.startsWith(`${key}-`)) {
            previous.durationMs = elapsed(activityStartedAt, item.observedAt) ?? previous.durationMs;
          }
          entries.push({ key: `${key}-${index}`, kind: "message", text: item.text });
        } else if (previous?.kind === "activity" && previous.key.startsWith(`${key}-`)) {
          previous.steps.push(item);
          previous.durationMs = elapsed(activityStartedAt, item.observedAt) ?? previous.durationMs;
        } else {
          activityStartedAt = previousAt;
          entries.push({ durationMs: elapsed(activityStartedAt, item.observedAt), key: `${key}-${index}`, kind: "activity", steps: [item] });
        }
        previousAt = item.observedAt ?? previousAt;
      });
      if (event.data.truncated) entries.push({ key: `${key}-truncated`, kind: "notice", text: "Part of this transcript was too long to keep." });
    } else if (event.type === "action_succeeded") {
      const kind = stringField(event.data, "kind");
      const url = stringField(event.data, "externalReference");
      if (kind === "open_github_pull_request" && url) {
        entries.push({
          key,
          kind: "pullRequest",
          number: /\/pull\/(\d+)/u.exec(url)?.[1] ?? null,
          repository: stringField(event.data, "repository"),
          title: stringField(event.data, "title"),
          url,
        });
      } else if (kind === "send_slack_message") {
        entries.push({ key, kind: "notice", text: "Sent a Slack message." });
      }
    } else if (event.type === "run_failed") {
      entries.push({ key, kind: "failure", text: stringField(event.data, "message") ?? "The run failed." });
    } else if (event.type === "run_cancelled") {
      entries.push({ key, kind: "notice", text: "The run was cancelled." });
    }
  }
  return entries;
}

function elapsed(from: number | undefined, to: number | undefined): number | null {
  return from === undefined || to === undefined ? null : Math.max(0, to - from);
}

// What an active run is doing, from the latest lifecycle event.
export function automationRunActivity(run: AutomationRunDetail): string {
  if (run.cancelRequestedAt) return "Stopping";
  if (run.status === "pending") return "Queued";
  const lifecycle = run.events.findLast((event) =>
    ["run_started", "sandbox_ready", "repositories_checked_out"].includes(event.type)
  );
  if (lifecycle?.type === "repositories_checked_out") return "Thinking";
  if (lifecycle?.type === "sandbox_ready") {
    return lifecycle.data?.resumed ? "Loading repositories" : "Checking out repositories";
  }
  return "Starting a sandbox";
}

export function lastAgentMessage(entries: AutomationRunEntry[]): string | null {
  const entry = entries.findLast((candidate) => candidate.kind === "message");
  return entry?.kind === "message" ? entry.text : null;
}

export const toolActionLabels: Record<AutomationToolAction, string> = {
  edit: "Edit",
  fetch: "Fetch",
  other: "Tool",
  query: "Query",
  read: "Read",
  run: "Run",
  search: "Search",
};

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// For example: "4 files read · 1 command run · Sentry and Datadog queried".
export function toolGroupSummary(tools: AutomationTranscriptTool[]): string {
  const counts = new Map<AutomationToolAction, number>();
  for (const tool of tools) counts.set(tool.action, (counts.get(tool.action) ?? 0) + 1);
  const providers = [...new Set(tools.flatMap((tool) => tool.action === "query" && tool.provider ? [providerDisplayName(tool.provider)] : []))];
  const unnamedQueries = tools.filter((tool) => tool.action === "query" && !tool.provider).length;
  const failed = tools.filter((tool) => tool.status === "failed").length;
  return [
    counts.get("read") ? count(counts.get("read")!, "file read", "files read") : null,
    counts.get("edit") ? count(counts.get("edit")!, "file edited", "files edited") : null,
    counts.get("run") ? count(counts.get("run")!, "command run", "commands run") : null,
    counts.get("search") ? count(counts.get("search")!, "search", "searches") : null,
    counts.get("fetch") ? count(counts.get("fetch")!, "page fetched", "pages fetched") : null,
    providers.length ? `${listNames(providers)} queried` : null,
    unnamedQueries ? count(unnamedQueries, "connector call", "connector calls") : null,
    counts.get("other") ? count(counts.get("other")!, "other tool", "other tools") : null,
    failed ? `${failed} failed` : null,
  ].filter(Boolean).join(" · ");
}

export function activityTools(steps: AutomationActivityStep[]): AutomationTranscriptTool[] {
  return steps.filter((step): step is AutomationTranscriptTool => step.kind === "tool");
}

// The observed duration, or the tools' own timing when a run predates it.
export function activityDuration(entry: Extract<AutomationRunEntry, { kind: "activity" }>): number | null {
  if (entry.durationMs !== null) return entry.durationMs;
  const tools = activityTools(entry.steps);
  if (!tools.some((tool) => tool.durationMs !== undefined)) return null;
  return tools.reduce((total, tool) => total + (tool.durationMs ?? 0), 0);
}

// For example "Thought for 12s" or "Ran 4 tools", with what the tools did.
export function activityLabel(entry: Extract<AutomationRunEntry, { kind: "activity" }>): { detail: string; title: string } {
  const tools = activityTools(entry.steps);
  const duration = activityDuration(entry);
  const thought = entry.steps.some((step) => step.kind === "reasoning");
  const ran = tools.length ? `Ran ${tools.length} ${tools.length === 1 ? "tool" : "tools"}` : null;
  if (thought) {
    return {
      detail: [ran, toolGroupSummary(tools)].filter(Boolean).join(" · "),
      title: duration === null ? "Thought" : `Thought for ${formatDuration(Math.max(1, Math.round(duration / 1_000)) * 1_000).replace(".0s", "s")}`,
    };
  }
  return {
    // Steps seen in the same read of the harness output have no useful time.
    detail: [duration === null || duration < 1_000 ? null : formatDuration(duration), toolGroupSummary(tools)].filter(Boolean).join(" · "),
    title: ran ?? "Worked",
  };
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 10_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
