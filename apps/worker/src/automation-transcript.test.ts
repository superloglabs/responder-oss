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

// Trimmed from a Claude Agent SDK run in which a background sub-agent started
// its own sub-agent.
const session = "0c6fe47b-d913-4e01-9691-bcc307c445f7";
const inventoryAgent = "toolu_01V8PgTiitLpuQvV2onB2Db5";
const batchAgent = "toolu_01GTiMrk2xg23CmMhSKfcxPJ";
const claudeSubagentEvents = [
  { type: "assistant", message: { id: "gen_01", type: "message", role: "assistant", content: [
    { type: "text", text: "I'll inventory the open pull requests." },
    { type: "tool_use", id: inventoryAgent, name: "Agent", input: { description: "Inventory open PRs compactly", subagent_type: "general-purpose", prompt: "Build a compact inventory of every open pull request.", run_in_background: true } },
  ] }, parent_tool_use_id: null, session_id: session },
  { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a7615f0c864ae038d", task_type: "local_agent", description: "Inventory open PRs compactly" }], session_id: session },
  { type: "system", subtype: "task_started", task_id: "a7615f0c864ae038d", tool_use_id: inventoryAgent, description: "Inventory open PRs compactly", subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1, task_type: "local_agent", session_id: session },
  { type: "user", message: { role: "user", content: [
    { tool_use_id: inventoryAgent, type: "tool_result", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: a7615f0c864ae038d" }] },
  ] }, parent_tool_use_id: null, session_id: session, tool_use_result: { isAsync: true, status: "async_launched", agentId: "a7615f0c864ae038d", description: "Inventory open PRs compactly" } },
  { type: "assistant", message: { id: "gen_02", type: "message", role: "assistant", content: [{ type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" }] }, parent_tool_use_id: inventoryAgent, session_id: session, subagent_type: "general-purpose", task_description: "Inventory open PRs compactly" },
  { type: "assistant", message: { id: "gen_02", type: "message", role: "assistant", content: [
    { type: "tool_use", id: "toolu_01KfNSWtjkpXnBQhQg5KTvFj", name: "mcp__responder__github_api", input: { path: "/repos/superloglabs/responder-oss/pulls?state=open&per_page=5&page=1" } },
  ] }, parent_tool_use_id: inventoryAgent, session_id: session, subagent_type: "general-purpose", task_description: "Inventory open PRs compactly", tool_use_meta: [{ id: "toolu_01KfNSWtjkpXnBQhQg5KTvFj", display_name: "Github Api", server_display_name: "responder-github" }] },
  { type: "system", subtype: "task_progress", task_id: "a7615f0c864ae038d", tool_use_id: inventoryAgent, description: "Inventory open PRs compactly", subagent_type: "general-purpose", usage: { total_tokens: 215, tool_uses: 1, duration_ms: 3455 }, last_tool_name: "mcp__responder__github_api", session_id: session },
  { type: "user", message: { role: "user", content: [
    { tool_use_id: "toolu_01KfNSWtjkpXnBQhQg5KTvFj", type: "tool_result", content: [{ type: "text", text: "HTTP 200\n\n[]" }] },
  ] }, parent_tool_use_id: inventoryAgent, session_id: session },
  { type: "assistant", message: { id: "gen_03", type: "message", role: "assistant", content: [
    { type: "tool_use", id: batchAgent, name: "Agent", input: { description: "PR inventory oss 1-5", subagent_type: "general-purpose", prompt: "Inventory pull requests 1 to 5.", run_in_background: true } },
  ] }, parent_tool_use_id: inventoryAgent, session_id: session, subagent_type: "general-purpose", task_description: "Inventory open PRs compactly" },
  { type: "system", subtype: "task_started", task_id: "a45593de912dfe35f", tool_use_id: batchAgent, description: "PR inventory oss 1-5", subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 2, task_type: "local_agent", session_id: session },
  { type: "user", message: { role: "user", content: [
    { tool_use_id: batchAgent, type: "tool_result", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: a45593de912dfe35f" }] },
  ] }, parent_tool_use_id: inventoryAgent, session_id: session },
  { type: "assistant", message: { id: "gen_04", type: "message", role: "assistant", content: [
    { type: "tool_use", id: "toolu_01UqETU3d9qMuD1MuJCo4ACn", name: "Bash", input: { command: "gh pr list --limit 5", description: "List pull requests" } },
  ] }, parent_tool_use_id: batchAgent, session_id: session, subagent_type: "general-purpose", task_description: "PR inventory oss 1-5" },
  { type: "tool_progress", tool_use_id: "toolu_01UqETU3d9qMuD1MuJCo4ACn-heartbeat-0", tool_name: "Bash", parent_tool_use_id: "toolu_01UqETU3d9qMuD1MuJCo4ACn", elapsed_time_seconds: 30, heartbeat: true, session_id: session },
  { type: "user", message: { role: "user", content: [
    { tool_use_id: "toolu_01UqETU3d9qMuD1MuJCo4ACn", type: "tool_result", content: "gh: rate limited", is_error: true },
  ] }, parent_tool_use_id: batchAgent, session_id: session },
  { type: "assistant", message: { id: "gen_05", type: "message", role: "assistant", content: [{ type: "text", text: "Pull requests 1 to 5 are all mergeable." }] }, parent_tool_use_id: batchAgent, session_id: session, subagent_type: "general-purpose", task_description: "PR inventory oss 1-5" },
  { type: "system", subtype: "task_updated", task_id: "a45593de912dfe35f", patch: { status: "completed", end_time: 1790528238171 }, session_id: session },
  { type: "system", subtype: "task_notification", task_id: "a45593de912dfe35f", tool_use_id: batchAgent, status: "completed", summary: "Pull requests 1 to 5 are all mergeable.", usage: { total_tokens: 20261, tool_uses: 1, duration_ms: 4873 }, session_id: session },
  { type: "assistant", message: { id: "gen_06", type: "message", role: "assistant", content: [{ type: "text", text: "Sent one subagent per batch." }] }, parent_tool_use_id: inventoryAgent, session_id: session, subagent_type: "general-purpose", task_description: "Inventory open PRs compactly" },
];

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
        { type: "tool_use", id: "tool-5", name: "mcp__responder__open_pull_request", input: {} },
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
      { action: "query", kind: "tool", provider: "github", status: "succeeded", target: "open_pull_request" },
      { kind: "message", text: "Done." },
    ]);
  });

  it("groups Claude sub-agent work under the Agent tool call that started it", () => {
    const transcript = parseAutomationTranscript("claude_agent_sdk", stream(...claudeSubagentEvents));

    expect(transcript).toEqual({
      items: [
        { kind: "message", text: "I'll inventory the open pull requests." },
        { action: "other", kind: "tool", status: "succeeded", subagent: { finished: false, id: inventoryAgent, type: "general-purpose" }, target: "Inventory open PRs compactly" },
        { action: "query", kind: "tool", provider: "github", status: "succeeded", subagentId: inventoryAgent, target: "github_api" },
        { action: "other", kind: "tool", status: "succeeded", subagent: { finished: true, id: batchAgent, type: "general-purpose" }, subagentId: inventoryAgent, target: "PR inventory oss 1-5" },
        { action: "run", kind: "tool", status: "failed", subagentId: batchAgent, target: "gh pr list --limit 5" },
        { kind: "message", subagentId: batchAgent, text: "Pull requests 1 to 5 are all mergeable." },
        { kind: "message", subagentId: inventoryAgent, text: "Sent one subagent per batch." },
      ],
      truncated: false,
    });
  });

  it("finishes a foreground sub-agent with its tool result and a failed one with its task", () => {
    const agent = (id: string, description: string) => ({ type: "assistant", message: { content: [
      { type: "tool_use", id, name: "Task", input: { description, subagent_type: "Explore", prompt: "Look around." } },
    ] }, parent_tool_use_id: null });
    const transcript = parseAutomationTranscript("claude_agent_sdk", stream(
      agent("tool-1", "Find the handler"),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "It is in src/app.ts." }] }] }, parent_tool_use_id: null },
      agent("tool-2", "Check the logs"),
      { type: "system", subtype: "task_started", task_id: "task-2", tool_use_id: "tool-2", description: "Check the logs", is_backgrounded: true, task_type: "local_agent" },
      { type: "system", subtype: "task_notification", task_id: "task-2", tool_use_id: "tool-2", status: "failed", summary: "The agent stopped." },
      agent("tool-3", "Still working"),
      { type: "system", subtype: "task_started", task_id: "task-3", tool_use_id: "tool-3", description: "Still working", is_backgrounded: true, task_type: "local_agent" },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-3", content: [{ type: "text", text: "Async agent launched successfully." }] }] }, parent_tool_use_id: null },
    ));

    expect(transcript.items).toEqual([
      { action: "other", kind: "tool", status: "succeeded", subagent: { finished: true, id: "tool-1", type: "Explore" }, target: "Find the handler" },
      { action: "other", kind: "tool", status: "failed", subagent: { finished: true, id: "tool-2", type: "Explore" }, target: "Check the logs" },
      { action: "other", kind: "tool", status: "succeeded", subagent: { finished: false, id: "tool-3", type: "Explore" }, target: "Still working" },
    ]);
  });

  it("keeps the main agent's items when sub-agents do a lot of work", () => {
    const busy = (agent: string) => Array.from({ length: 30 }, (_, index) => ({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: `${agent}-read-${index}`, name: "Read", input: { file_path: `/home/daytona/workspace/src/${index}.ts` } }] },
      parent_tool_use_id: agent,
    }));
    const agents = Array.from({ length: 20 }, (_, index) => `agent-${index}`);
    const eventStream = stream(
      { type: "assistant", message: { content: agents.map((id) => ({ type: "tool_use", id, name: "Agent", input: { description: id, run_in_background: true } })) } },
      ...agents.flatMap((agent) => [
        ...busy(agent),
        { type: "assistant", message: { content: [{ type: "text", text: `${agent} is done.` }] }, parent_tool_use_id: agent },
      ]),
      { type: "assistant", message: { content: [{ type: "text", text: "All batches are done." }] }, parent_tool_use_id: null },
    );
    const transcript = parseAutomationTranscript("claude_agent_sdk", eventStream);
    const first = transcript.items.filter((item) => item.subagentId === "agent-0");

    expect(transcript.truncated).toBe(true);
    expect(first).toHaveLength(21);
    expect(first.at(-1)).toEqual({ kind: "message", subagentId: "agent-0", text: "agent-0 is done." });
    expect(transcript.items.at(-1)).toEqual({ kind: "message", text: "All batches are done." });
    // A longer stream only adds items.
    const shorter = parseAutomationTranscript("claude_agent_sdk", eventStream.split("\n").slice(0, -40).join("\n"));
    expect(transcript.items.slice(0, shorter.items.length)).toEqual(shorter.items);
  });

  it("drops a sub-agent completion notice the model repeats after compacting its context", () => {
    const transcript = parseAutomationTranscript("claude_agent_sdk", stream(
      { type: "assistant", message: { content: [{ type: "text", text: "<task-notification>\n<task-id>ab12</task-id>\n<status>completed</status>\n</task-notification>" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "The inventory is in." }] } },
    ));

    expect(transcript.items).toEqual([{ kind: "message", text: "The inventory is in." }]);
  });

  it("reads OpenCode parts with their durations", () => {
    const transcript = parseAutomationTranscript("opencode", stream(
      { type: "step_start", part: { id: "step-1", type: "step-start" } },
      { type: "reasoning", part: { id: "part-0", type: "reasoning", text: "Read the handler first." } },
      { type: "tool_use", part: { id: "part-1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/home/daytona/workspace/src/app.ts" }, time: { start: 1_000, end: 1_400 } } } },
      { type: "tool_use", part: { id: "part-2", type: "tool", tool: "bash", state: { status: "error", input: { command: "pnpm test" }, time: { start: 2_000, end: 10_200 } } } },
      { type: "tool_use", part: { id: "part-3", type: "tool", tool: `${sentryServer}_get_issue`, state: { status: "completed", input: {} } } },
      { type: "tool_use", part: { id: "part-5", type: "tool", tool: "responder_open_pull_request", state: { status: "completed", input: {} } } },
      { type: "text", part: { id: "part-4", type: "text", text: "All set." } },
    ));

    expect(transcript.items).toEqual([
      { kind: "reasoning", text: "Read the handler first." },
      { action: "read", durationMs: 400, kind: "tool", status: "succeeded", target: "src/app.ts" },
      { action: "run", durationMs: 8_200, kind: "tool", status: "failed", target: "pnpm test" },
      { action: "query", kind: "tool", provider: "sentry", status: "succeeded", target: "get_issue" },
      { action: "query", kind: "tool", provider: "github", status: "succeeded", target: "open_pull_request" },
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
