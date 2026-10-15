import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { AutomationHarnessError } from "./automation-harness.js";
import {
  buildClaudeAutomationCommand,
  claudeAgentSdkVersion,
  claudeMcpToolTimeoutMs,
  prepareClaudeAutomationHarness,
  runClaudeAutomation,
} from "./claude-automation-harness.js";

const input = {
  contextServers: [],
  model: {
    brokerBaseUrl: "https://models.responder.test/v1",
    model: "claude-sonnet-4-5",
    provider: "anthropic",
  },
  prompt: "Fix the failing test.",
  workspacePath: "/home/daytona/workspace",
};

describe("Claude automation harness", () => {
  it("installs a pinned SDK without exposing the broker token to setup", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: install\nProcess exited with code 0\nOutput:\n",
      ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;

    await prepareClaudeAutomationHarness(session);

    const command = vi.mocked(session.execCommand).mock.calls[0]![0].cmd;
    expect(command).toContain(
      `@anthropic-ai/claude-agent-sdk@${claudeAgentSdkVersion}`,
    );
    expect(command).toContain("unset RESPONDER_MODEL_BROKER_TOKEN");
  });

  it("lets the agent take four hundred turns", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: install\nProcess exited with code 0\nOutput:\n",
      ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;

    await prepareClaudeAutomationHarness(session);

    const runner = vi.mocked(session.materializeEntry).mock.calls[0]![0].entry;
    expect(runner).toMatchObject({ type: "file" });
    expect((runner as { content: string }).content).toContain("maxTurns: 400,");
  });

  it("runs unattended through only the scoped broker", () => {
    const command = buildClaudeAutomationCommand(input);

    expect(command).toContain(
      'ANTHROPIC_AUTH_TOKEN="$RESPONDER_MODEL_BROKER_TOKEN"',
    );
    // Claude Code appends /v1/messages to its base URL itself.
    expect(command).toContain(
      "ANTHROPIC_BASE_URL='https://models.responder.test'",
    );
    expect(command).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    // Sandboxes run as root, where Claude Code only bypasses permissions
    // after the caller confirms the environment is isolated.
    expect(command).toContain("IS_SANDBOX=1");
    expect(command).toContain(`MCP_TOOL_TIMEOUT=${claudeMcpToolTimeoutMs}`);
    expect(command).toContain("RESPONDER_AUTOMATION_MODEL='claude-sonnet-4-5'");
    expect(command).toContain("claude-agent-sdk-runner.mjs");
    expect(command).not.toContain(input.prompt);
  });

  it("caps output at the grant's per-request limit", () => {
    const command = buildClaudeAutomationCommand({
      ...input,
      model: { ...input.model, maxOutputTokensPerRequest: 16_000 },
    });

    expect(command).toContain("CLAUDE_CODE_MAX_OUTPUT_TOKENS=16000");
    expect(buildClaudeAutomationCommand(input)).not.toContain(
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    );
    expect(() =>
      buildClaudeAutomationCommand({
        ...input,
        model: { ...input.model, maxOutputTokensPerRequest: 0 },
      })
    ).toThrow("positive integer");
  });

  it("hands the worker's tool server to the runner", () => {
    const toolServer = {
      args: ["/home/daytona/workspace/.responder/tools/server.mjs"],
      command: "node",
      name: "superlog",
    };

    expect(buildClaudeAutomationCommand({ ...input, toolServer })).toContain(
      `RESPONDER_AUTOMATION_TOOL_SERVER='${JSON.stringify(toolServer)}'`,
    );
    expect(buildClaudeAutomationCommand(input)).not.toContain(
      "RESPONDER_AUTOMATION_TOOL_SERVER",
    );
  });

  it("rejects non-Anthropic models", () => {
    expect(() =>
      buildClaudeAutomationCommand({
        ...input,
        model: { ...input.model, provider: "openai" },
      })
    ).toThrow("require an Anthropic model");
  });

  const failedRun = (output: string) => ({
    execCommand: vi
      .fn()
      .mockResolvedValueOnce("Chunk ID: workspace\nProcess exited with code 0\nOutput:\n")
      .mockResolvedValueOnce("Chunk ID: install\nProcess exited with code 0\nOutput:\n")
      .mockResolvedValue(output),
    materializeEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaytonaSandboxSession);

  it("names the error of the result message that ended the run", async () => {
    const result = JSON.stringify({
      errors: ["API Error: 529 Overloaded"],
      is_error: true,
      subtype: "error_during_execution",
      type: "result",
    });
    const run = runClaudeAutomation(
      failedRun(`Chunk ID: run\nProcess exited with code 1\nOutput:\n${result}\n`),
      input,
    );

    await expect(run).rejects.toThrow(
      /^Claude automation harness failed: API Error: 529 Overloaded$/u,
    );
    // The output stays available for the run transcript.
    await expect(run).rejects.toBeInstanceOf(AutomationHarnessError);
  });

  it("names a run the sandbox killed before Claude reported a result", async () => {
    const assistant = JSON.stringify({ message: { content: [] }, type: "assistant" });

    await expect(runClaudeAutomation(
      failedRun(`Chunk ID: run\nProcess exited with code 137\nOutput:\n${assistant}\n`),
      input,
    )).rejects.toThrow(
      /^Claude automation harness failed: Claude was killed with exit code 137, most likely because the sandbox ran out of memory$/u,
    );
  });

  it("names the exit code when Claude reported no error", async () => {
    await expect(runClaudeAutomation(
      failedRun("Chunk ID: run\nProcess exited with code 1\nOutput:\n"),
      input,
    )).rejects.toThrow(/^Claude automation harness failed: Claude exited with code 1$/u);
  });
});
