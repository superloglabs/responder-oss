import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenCodeAutomationCommand,
  openCodeAutomationConfig,
  openCodeVersion,
  prepareOpenCodeAutomationHarness,
} from "./opencode-automation-harness.js";

const input = {
  contextServers: [{
    name: "sentry_61616161616141618161616161616161",
    url: "https://responder.test/api/automation-context-broker/v1/61616161-6161-4161-8161-616161616161",
  }],
  model: {
    brokerBaseUrl: "https://models.responder.test/v1",
    model: "gpt-5.4",
    provider: "openai",
  },
  prompt: "Fix the failing test.",
  workspacePath: "/home/daytona/workspace",
};

describe("OpenCode automation harness", () => {
  it("installs a pinned CLI without exposing the broker token to setup", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: install\nProcess exited with code 0\nOutput:\n",
      ),
    } as unknown as DaytonaSandboxSession;

    await prepareOpenCodeAutomationHarness(session);

    const command = vi.mocked(session.execCommand).mock.calls[0]![0].cmd;
    expect(command).toContain(`opencode-ai@${openCodeVersion}`);
    expect(command).toContain("unset RESPONDER_MODEL_BROKER_TOKEN");
  });

  it("uses the Responses adapter for OpenAI and the Messages adapter for Anthropic", () => {
    expect(openCodeAutomationConfig(input)).toMatchObject({
      permission: { "*": "allow" },
      mcp: {
        sentry_61616161616141618161616161616161: {
          type: "remote",
        },
      },
      provider: {
        responder: {
          npm: "@ai-sdk/openai",
          options: {
            apiKey: "{env:RESPONDER_MODEL_BROKER_TOKEN}",
          },
        },
      },
      share: "disabled",
      shell: "/home/daytona/workspace/.responder/opencode-shell",
    });
    expect(openCodeAutomationConfig({
      ...input,
      model: { ...input.model, model: "claude-sonnet-4-5", provider: "anthropic" },
    })).toMatchObject({
      provider: { responder: { npm: "@ai-sdk/anthropic" } },
    });
  });

  it("keeps the prompt out of the shell command", () => {
    const command = buildOpenCodeAutomationCommand(input);
    expect(command).toContain("OPENCODE_CONFIG=");
    expect(command).toContain("prompt=$(cat '/home/daytona/workspace/.responder/automation-prompt.txt')");
    expect(command).toContain('-- "$prompt"');
    expect(command).not.toContain(input.prompt);
  });
});
