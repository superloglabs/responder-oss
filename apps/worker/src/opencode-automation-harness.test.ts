import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenCodeAutomationCommand,
  openCodeAutomationConfig,
  openCodeHarnessFailure,
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

const toolServer = {
  args: ["/home/daytona/workspace/.responder/tools/server.mjs"],
  command: "node",
  name: "superlog",
};

describe("OpenCode automation harness", () => {
  it("starts the worker's tool server as a local MCP server", () => {
    expect(openCodeAutomationConfig({ ...input, toolServer }).mcp).toMatchObject({
      superlog: {
        command: ["node", "/home/daytona/workspace/.responder/tools/server.mjs"],
        enabled: true,
        type: "local",
      },
      sentry_61616161616141618161616161616161: { type: "remote" },
    });
  });

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
    // The package's own postinstall links the platform binary.
    expect(command).toContain(`node '/home/daytona/workspace/.responder/opencode/${openCodeVersion}/node_modules/opencode-ai/postinstall.mjs'`);
  });

  it("uses the Chat Completions adapter for OpenAI and the Messages adapter for Anthropic", () => {
    expect(openCodeAutomationConfig(input)).toMatchObject({
      permission: { "*": "allow" },
      mcp: {
        sentry_61616161616141618161616161616161: {
          type: "remote",
        },
      },
      provider: {
        responder: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            apiKey: "{env:RESPONDER_MODEL_BROKER_TOKEN}",
            baseURL: "https://models.responder.test/v1/providers/openai",
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

  it("caps output tokens at the grant's per-request limit", () => {
    const config = openCodeAutomationConfig({
      ...input,
      model: { ...input.model, maxOutputTokensPerRequest: 16_000 },
    });
    expect(config.provider.responder.models["gpt-5.4"]).toMatchObject({
      limit: { context: 0, output: 16_000 },
    });
    expect(() => openCodeAutomationConfig({
      ...input,
      model: { ...input.model, maxOutputTokensPerRequest: 0 },
    })).toThrow("Maximum output tokens per request must be a positive integer");
  });

  it("keeps the prompt out of the shell command", () => {
    const command = buildOpenCodeAutomationCommand(input);
    expect(command).toContain("OPENCODE_CONFIG=");
    expect(command).toContain("prompt=$(cat '/home/daytona/workspace/.responder/automation-prompt.txt')");
    expect(command).toContain('-- "$prompt"');
    expect(command).not.toContain(input.prompt);
  });
});

it.each(["google", "xai", "mistral", "deepseek"])("uses scoped chat completion routes for %s", provider => {
  const config = openCodeAutomationConfig({ ...input, model: { ...input.model, provider, model: "current-model" } });
  expect(config.provider.responder.npm).toBe("@ai-sdk/openai-compatible");
  expect(config.provider.responder.options.baseURL).toBe(`https://models.responder.test/v1/providers/${provider}`);
  expect(config.provider.responder.models["current-model"].tool_call).toBe(true);
});

describe("OpenCode harness result", () => {
  const exec = (exitCode: number, ...events: unknown[]) =>
    `Chunk ID: abc123\nWall time: 8.6543 seconds\nProcess exited with code ${exitCode}\nOutput:\n${events.map((event) => JSON.stringify(event)).join("\n")}`;
  const step = { type: "step_finish", part: { reason: "stop", type: "step-finish" } };

  it("accepts a run that finished a step", () => {
    expect(openCodeHarnessFailure(exec(0, { type: "step_start" }, step))).toBeNull();
  });

  it("fails a run that exited 0 without any output", () => {
    expect(openCodeHarnessFailure(exec(0))).toBe(
      "OpenCode automation harness failed: OpenCode finished without a model response",
    );
  });

  it("fails a run that reported a model error, whatever its exit code", () => {
    const error = {
      error: { data: { message: "Payment Required: The usage allowance for this billing period is used up", statusCode: 402 }, name: "APIError" },
      type: "error",
    };
    for (const exitCode of [0, 1]) {
      expect(openCodeHarnessFailure(exec(exitCode, error))).toBe(
        "OpenCode automation harness failed: Payment Required: The usage allowance for this billing period is used up",
      );
    }
  });

  it("names the exit code when OpenCode printed no error", () => {
    expect(openCodeHarnessFailure(exec(137))).toBe(
      "OpenCode automation harness failed: OpenCode exited with code 137",
    );
  });
});
