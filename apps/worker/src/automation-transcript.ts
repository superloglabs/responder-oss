import type {
  AutomationToolAction,
  AutomationTranscriptEventData,
  AutomationTranscriptItem,
  AutomationTranscriptSubagent,
  AutomationTranscriptTool,
} from "@responder/core/automations/transcript";
import {
  automationToolProvider,
  automationToolServerName,
  automationWorkspaceRoot,
  type AutomationHarnessKind,
} from "./automation-harness.js";
import { redactDaytonaSecretPlaceholders } from "./secret-safety.js";

const maxItems = 500;
// Sub-agents can do far more than the main agent, so their items have a
// smaller share and the main agent's later items still fit.
const maxSubagentItems = 300;
const maxStepsPerSubagent = 20;
const maxMessageLength = 20_000;
const maxTargetLength = 400;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonLines(eventStream: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of eventStream.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Harness logs and truncated lines are not events.
    }
  }
  return records;
}

function displayPath(value: string): string {
  return value.startsWith(`${automationWorkspaceRoot}/`)
    ? value.slice(automationWorkspaceRoot.length + 1)
    : value;
}

// Codex runs every command through a login shell; show the inner command,
// with workspace paths made relative.
function displayCommand(value: string): string {
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh -l?c (?:(['"])([\s\S]*)\1|([^'"][\s\S]*))$/u.exec(value.trim());
  return (wrapped?.[2] ?? wrapped?.[3] ?? value).replaceAll(`${automationWorkspaceRoot}/`, "");
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

// Context servers are named `<provider>_<connection id>`. A Google Cloud
// connection has one server per Google service, named with that suffix.
const gcpServiceSuffix = "(?:_(?:assets|logging|monitoring))?";
const contextServerPattern = new RegExp(`^(custom_mcp|[a-z]+)_[0-9a-f]{32}${gcpServiceSuffix}$`, "u");
const openCodeMcpToolPattern = new RegExp(
  `^(?:(custom_mcp|[a-z]+)_[0-9a-f]{32}${gcpServiceSuffix}|(${automationToolServerName}))_(.+)$`,
  "u",
);

// Context servers are named for their connection. The worker's own tool
// server serves several providers, so its tools name theirs.
function mcpProvider(server: string, tool: string): string | undefined {
  if (server === automationToolServerName) return automationToolProvider(tool);
  return contextServerPattern.exec(server)?.[1];
}

function tool(
  action: AutomationToolAction,
  target: string,
  status: AutomationTranscriptTool["status"],
  extra: Partial<Pick<AutomationTranscriptTool, "durationMs" | "provider" | "subagentId">> = {},
): AutomationTranscriptTool {
  return {
    action,
    kind: "tool",
    status,
    target: clip(oneLine(target), maxTargetLength),
    ...extra,
  };
}

function parseCodex(records: JsonRecord[]): AutomationTranscriptItem[] {
  const items: AutomationTranscriptItem[] = [];
  for (const record of records) {
    if (record.type !== "item.completed" || !isRecord(record.item)) continue;
    const item = record.item;
    const failed = item.status === "failed" || item.status === "declined";
    switch (item.type) {
      case "agent_message":
        if (text(item.text).trim()) items.push({ kind: "message", text: text(item.text) });
        break;
      case "reasoning":
        if (text(item.text).trim()) items.push({ kind: "reasoning", text: text(item.text) });
        break;
      case "command_execution": {
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : 0;
        items.push(tool("run", displayCommand(text(item.command)), failed || exitCode !== 0 ? "failed" : "succeeded"));
        break;
      }
      case "file_change":
        for (const change of Array.isArray(item.changes) ? item.changes : []) {
          if (isRecord(change)) items.push(tool("edit", displayPath(text(change.path)), failed ? "failed" : "succeeded"));
        }
        break;
      case "mcp_tool_call": {
        const provider = mcpProvider(text(item.server), text(item.tool));
        items.push(tool("query", text(item.tool), failed || Boolean(item.error) ? "failed" : "succeeded", provider ? { provider } : {}));
        break;
      }
      case "web_search":
        items.push(tool("search", text(item.query), "succeeded"));
        break;
    }
  }
  return items;
}

function claudeTool(name: string, input: JsonRecord): { action: AutomationToolAction; provider?: string; target: string } | null {
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name);
  if (mcp) {
    const provider = mcpProvider(mcp[1]!, mcp[2]!);
    return { action: "query", target: mcp[2]!, ...(provider ? { provider } : {}) };
  }
  switch (name) {
    case "Read":
      return { action: "read", target: displayPath(text(input.file_path)) };
    case "LS":
      return { action: "read", target: displayPath(text(input.path)) };
    case "Edit":
    case "MultiEdit":
    case "Write":
      return { action: "edit", target: displayPath(text(input.file_path)) };
    case "NotebookEdit":
      return { action: "edit", target: displayPath(text(input.notebook_path)) };
    case "Bash":
      return { action: "run", target: displayCommand(text(input.command)) };
    case "Glob":
    case "Grep":
      return { action: "search", target: text(input.pattern) };
    case "WebSearch":
      return { action: "search", target: text(input.query) };
    case "WebFetch":
      return { action: "fetch", target: text(input.url) };
    case "TodoWrite":
      return null;
    default:
      return { action: "other", target: text(input.description) || name };
  }
}

function parseClaude(records: JsonRecord[]): AutomationTranscriptItem[] {
  const items: AutomationTranscriptItem[] = [];
  const tools = new Map<string, AutomationTranscriptTool>();
  // Sub-agents by task id, which task events use.
  const tasks = new Map<string, AutomationTranscriptSubagent>();
  // Agent tool calls whose result only says the sub-agent started.
  const background = new Set<string>();
  for (const record of records) {
    // Sub-agent messages name the Agent tool call that started them.
    const origin = text(record.parent_tool_use_id) ? { subagentId: text(record.parent_tool_use_id) } : {};
    const content = isRecord(record.message) && Array.isArray(record.message.content)
      ? record.message.content.filter(isRecord)
      : [];
    if (record.type === "assistant") {
      const thinking = content
        .filter((block) => block.type === "thinking")
        .map((block) => text(block.thinking))
        .join("\n\n");
      if (thinking.trim()) items.push({ kind: "reasoning", text: thinking, ...origin });
      const message = content
        .filter((block) => block.type === "text")
        .map((block) => text(block.text))
        // After compacting its context the model can repeat a sub-agent's
        // completion notice as its reply; the notice is not a message.
        .filter((value) => !value.trimStart().startsWith("<task-notification>"))
        .join("\n\n");
      if (message.trim()) items.push({ kind: "message", text: message, ...origin });
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const input = isRecord(block.input) ? block.input : {};
        const described = claudeTool(text(block.name), input);
        if (!described) continue;
        const item = tool(described.action, described.target, "succeeded", {
          ...(described.provider ? { provider: described.provider } : {}),
          ...origin,
        });
        if (block.name === "Agent" || block.name === "Task") {
          item.subagent = { finished: false, id: text(block.id), ...(text(input.subagent_type) ? { type: text(input.subagent_type) } : {}) };
          if (input.run_in_background === true) background.add(text(block.id));
        }
        tools.set(text(block.id), item);
        items.push(item);
      }
    } else if (record.type === "user") {
      const result = isRecord(record.tool_use_result) ? record.tool_use_result : {};
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const item = tools.get(text(block.tool_use_id));
        if (!item) continue;
        if (block.is_error === true) item.status = "failed";
        if (item.subagent && !background.has(text(block.tool_use_id)) && result.isAsync !== true) item.subagent.finished = true;
      }
    } else if (record.type === "system" && record.subtype === "task_started") {
      // A sub-agent that receives a message starts again under the same task.
      const subagent = tasks.get(text(record.task_id)) ?? tools.get(text(record.tool_use_id))?.subagent;
      if (!subagent) continue;
      tasks.set(text(record.task_id), subagent);
      subagent.finished = false;
      if (record.is_backgrounded === true) background.add(subagent.id);
    } else if (record.type === "system" && record.subtype === "task_notification") {
      const subagent = tasks.get(text(record.task_id));
      if (!subagent) continue;
      subagent.finished = true;
      if (record.status === "failed") tools.get(subagent.id)!.status = "failed";
    }
  }
  return items;
}

function openCodeTool(name: string, input: JsonRecord): { action: AutomationToolAction; provider?: string; target: string } | null {
  const mcp = openCodeMcpToolPattern.exec(name);
  if (mcp) return { action: "query", provider: mcp[1] ?? automationToolProvider(mcp[3]!), target: mcp[3]! };
  switch (name) {
    case "read":
      return { action: "read", target: displayPath(text(input.filePath)) };
    case "list":
      return { action: "read", target: displayPath(text(input.path)) };
    case "edit":
    case "multiedit":
    case "patch":
    case "write":
      return { action: "edit", target: displayPath(text(input.filePath)) };
    case "bash":
      return { action: "run", target: displayCommand(text(input.command)) };
    case "glob":
    case "grep":
      return { action: "search", target: text(input.pattern) };
    case "codesearch":
    case "websearch":
      return { action: "search", target: text(input.query) };
    case "webfetch":
      return { action: "fetch", target: text(input.url) };
    case "todoread":
    case "todowrite":
      return null;
    default:
      return { action: "other", target: text(input.description) || name };
  }
}

function parseOpenCode(records: JsonRecord[]): AutomationTranscriptItem[] {
  // Parts can be reported more than once; the latest report wins.
  const parts = new Map<string, AutomationTranscriptItem | null>();
  let anonymous = 0;
  for (const record of records) {
    const part = isRecord(record.part) ? record.part : null;
    if (!part) continue;
    const key = text(part.id) || `anonymous-${anonymous++}`;
    if (record.type === "text" && part.type === "text") {
      parts.set(key, text(part.text).trim() ? { kind: "message", text: text(part.text) } : null);
    } else if (record.type === "reasoning" && part.type === "reasoning") {
      parts.set(key, text(part.text).trim() ? { kind: "reasoning", text: text(part.text) } : null);
    } else if (record.type === "tool_use" && part.type === "tool" && isRecord(part.state)) {
      const state = part.state;
      const described = openCodeTool(text(part.tool), isRecord(state.input) ? state.input : {});
      if (!described) continue;
      const time = isRecord(state.time) ? state.time : {};
      const durationMs = typeof time.start === "number" && typeof time.end === "number" && time.end >= time.start
        ? time.end - time.start
        : undefined;
      parts.set(key, tool(described.action, described.target, state.status === "error" ? "failed" : "succeeded", {
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(described.provider ? { provider: described.provider } : {}),
      }));
    }
  }
  return [...parts.values()].filter((item): item is AutomationTranscriptItem => item !== null);
}

// Keeps each sub-agent's first steps and all of its messages. An item is kept
// or dropped based only on the items before it, so the list only grows as the
// harness writes more events.
function limitItems(parsed: AutomationTranscriptItem[]): AutomationTranscriptItem[] {
  const items: AutomationTranscriptItem[] = [];
  const steps = new Map<string, number>();
  let subagentItems = 0;
  for (const item of parsed) {
    if (items.length === maxItems) break;
    if (item.subagentId) {
      if (subagentItems === maxSubagentItems) continue;
      if (item.kind !== "message") {
        const count = steps.get(item.subagentId) ?? 0;
        if (count === maxStepsPerSubagent) continue;
        steps.set(item.subagentId, count + 1);
      }
      subagentItems += 1;
    }
    items.push(item);
  }
  return items;
}

export function parseAutomationTranscript(
  harness: AutomationHarnessKind,
  eventStream: string,
): AutomationTranscriptEventData {
  const records = jsonLines(eventStream);
  const parsed = harness === "codex"
    ? parseCodex(records)
    : harness === "claude_agent_sdk"
      ? parseClaude(records)
      : parseOpenCode(records);
  const kept = limitItems(parsed);
  const items = kept.map((item): AutomationTranscriptItem =>
    item.kind === "tool"
      ? { ...item, target: redactDaytonaSecretPlaceholders(item.target) }
      : { ...item, text: clip(redactDaytonaSecretPlaceholders(item.text), maxMessageLength) }
  );
  return {
    items,
    truncated: kept.length < parsed.length || /\.\.\.\d+ tokens truncated\.\.\./u.test(eventStream),
  };
}
