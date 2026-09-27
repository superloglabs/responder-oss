import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeAutomationCommand,
  claudeAgentSdkVersion,
  claudeMcpToolTimeoutMs,
  prepareClaudeAutomationHarness,
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
      name: "responder",
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
});
