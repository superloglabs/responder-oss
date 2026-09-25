import { describe, expect, it } from "vitest";
import { parseAutomationTranscript } from "./automation-transcript.js";

function stream(...events: unknown[]): string {
  return [
    "Chunk ID: run",
    "Wall time: 12.0000 seconds",
    "Process exited with code 0",
    "Output:",
    "npm warn deprecated something",
    ...events.map((event) => JSON.stringify(event)),
  ].join("\n");
}

const sentryServer = `sentry_${"a".repeat(32)}`;

describe("parseAutomationTranscript", () => {
  it("reads Codex messages, commands, file changes and connector calls", () => {
    const transcript = parseAutomationTranscript("codex", stream(
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { id: "1", type: "reasoning", text: "Thinking" } },
      { type: "item.completed", item: { id: "2", type: "agent_message", text: "I'll look at the handler." } },
      { type: "item.started", item: { id: "3", type: "command_execution", command: "bash -lc 'cat src/app.ts'", status: "in_progress" } },
      { type: "item.completed", item: { id: "3", type: "command_execution", command: "bash -lc 'cat src/app.ts'", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "4", type: "command_execution", command: "bash -lc 'nl -ba /home/daytona/workspace/src/app.ts'", exit_code: 1, status: "failed" } },
      { type: "item.completed", item: { id: "5", type: "file_change", changes: [{ kind: "update", path: "/home/daytona/workspace/repositories/acme/app/src/app.ts" }], status: "completed" } },
      { type: "item.completed", item: { id: "6", type: "mcp_tool_call", server: sentryServer, tool: "get_issue", status: "completed" } },
      { type: "item.completed", item: { id: "7", type: "todo_list", items: [] } },
      { type: "item.completed", item: { id: "8", type: "command_execution", command: "/bin/bash -c pwd", exit_code: 0, status: "completed" } },
      { type: "turn.completed", usage: {} },
    ));

    expect(transcript).toEqual({
      items: [
        { kind: "reasoning", text: "Thinking" },
        { kind: "message", text: "I'll look at the handler." },
        { action: "run", kind: "tool", status: "succeeded", target: "cat src/app.ts" },
        { action: "run", kind: "tool", status: "failed", target: "nl -ba src/app.ts" },
        { action: "edit", kind: "tool", status: "succeeded", target: "repositories/acme/app/src/app.ts" },
        { action: "query", kind: "tool", provider: "sentry", status: "succeeded", target: "get_issue" },
        { action: "run", kind: "tool", status: "succeeded", target: "pwd" },
      ],
      truncated: false,
    });
  });

  it("reads Claude Agent SDK messages and marks failed tool results", () => {
    const transcript = parseAutomationTranscript("claude_agent_sdk", stream(
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [
        { type: "thinking", thinking: "The logs will show the failing request." },
        { type: "text", text: "Checking the logs." },
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/home/daytona/workspace/src/app.ts" } },
        { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "pnpm test" } },
        { type: "tool_use", id: "tool-3", name: `mcp__${sentryServer}__search_issues`, input: {} },
        { type: "tool_use", id: "tool-4", name: "TodoWrite", input: {} },
      ] } },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "tool-1", is_error: false },
        { type: "tool_result", tool_use_id: "tool-2", is_error: true },
      ] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
      { type: "result", subtype: "success", result: "Done." },
    ));

    expect(transcript.items).toEqual([
      { kind: "reasoning", text: "The logs will show the failing request." },
      { kind: "message", text: "Checking the logs." },
      { action: "read", kind: "tool", status: "succeeded", target: "src/app.ts" },
      { action: "run", kind: "tool", status: "failed", target: "pnpm test" },
      { action: "query", kind: "tool", provider: "sentry", status: "succeeded", target: "search_issues" },
      { kind: "message", text: "Done." },
    ]);
  });

  it("reads OpenCode parts with their durations", () => {
    const transcript = parseAutomationTranscript("opencode", stream(
      { type: "step_start", part: { id: "step-1", type: "step-start" } },
      { type: "reasoning", part: { id: "part-0", type: "reasoning", text: "Read the handler first." } },
      { type: "tool_use", part: { id: "part-1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/home/daytona/workspace/src/app.ts" }, time: { start: 1_000, end: 1_400 } } } },
      { type: "tool_use", part: { id: "part-2", type: "tool", tool: "bash", state: { status: "error", input: { command: "pnpm test" }, time: { start: 2_000, end: 10_200 } } } },
      { type: "tool_use", part: { id: "part-3", type: "tool", tool: `${sentryServer}_get_issue`, state: { status: "completed", input: {} } } },
      { type: "text", part: { id: "part-4", type: "text", text: "All set." } },
    ));

    expect(transcript.items).toEqual([
      { kind: "reasoning", text: "Read the handler first." },
      { action: "read", durationMs: 400, kind: "tool", status: "succeeded", target: "src/app.ts" },
      { action: "run", durationMs: 8_200, kind: "tool", status: "failed", target: "pnpm test" },
      { action: "query", kind: "tool", provider: "sentry", status: "succeeded", target: "get_issue" },
      { kind: "message", text: "All set." },
    ]);
  });

  it("redacts secret placeholders and reports truncated output", () => {
    const transcript = parseAutomationTranscript("codex", [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Used dtn_secret_abc123 to call the API." } }),
      "...120 tokens truncated...",
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "curl -H 'Bearer dtn_secret_abc123'", exit_code: 0, status: "completed" } }),
    ].join("\n"));

    expect(JSON.stringify(transcript.items)).not.toContain("dtn_secret_abc123");
    expect(transcript.truncated).toBe(true);
  });
});
