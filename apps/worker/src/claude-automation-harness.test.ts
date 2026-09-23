import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeAutomationCommand,
  claudeAgentSdkVersion,
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
    expect(command).toContain(
      "ANTHROPIC_BASE_URL='https://models.responder.test/v1'",
    );
    expect(command).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    expect(command).not.toContain(input.prompt);
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
