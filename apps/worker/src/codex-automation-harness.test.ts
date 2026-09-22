import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexAutomationCommand,
  codexCliVersion,
  prepareCodexAutomationHarness,
  runCodexAutomation,
} from "./codex-automation-harness.js";

const input = {
  model: {
    brokerBaseUrl: "https://models.responder.test/v1",
    model: "gpt-5.4",
    provider: "openai",
  },
  prompt: "Fix the flaky test; don't print CUSTOMER_PROVIDER_KEY.",
  workspacePath: "/home/daytona/workspace/repositories/responder",
};

describe("Codex automation harness", () => {
  it("uses a pinned CLI package inside the sandbox", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: install\nProcess exited with code 0\nOutput:\n",
      ),
    } as unknown as DaytonaSandboxSession;

    await expect(prepareCodexAutomationHarness(session)).resolves.toBeUndefined();

    expect(session.execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining(`@openai/codex@${codexCliVersion}`),
        workdir: "/home/daytona/workspace",
      }),
    );
  });

  it("fails safely when the pinned CLI cannot be prepared", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: install\nProcess exited with code 1\nOutput:\nnpm failed with a private registry message\n",
      ),
    } as unknown as DaytonaSandboxSession;

    await expect(prepareCodexAutomationHarness(session)).rejects.toThrow(
      "Unable to prepare the pinned Codex automation harness",
    );
  });

  it("runs unattended and ephemeral against only the model broker", () => {
    const command = buildCodexAutomationCommand(input);

    expect(command).toContain("--ephemeral");
    expect(command).toContain("--ignore-user-config");
    expect(command).toContain("--ignore-rules");
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command).toContain('model_provider="responder"');
    expect(command).toContain(
      'model_providers.responder.base_url="https://models.responder.test/v1"',
    );
    expect(command).toContain(
      'model_providers.responder.env_key="RESPONDER_MODEL_BROKER_TOKEN"',
    );
    expect(command).toContain("shell_environment_policy.inherit=\"core\"");
    expect(command).toContain(
      "shell_environment_policy.ignore_default_excludes=false",
    );
    expect(command).toContain(
      'shell_environment_policy.filters={ RESPONDER_MODEL_BROKER_TOKEN = "exclude" }',
    );
    expect(command).not.toContain(input.prompt);
    expect(command).not.toContain("CUSTOMER_PROVIDER_KEY");
  });

  it("materializes the prompt without putting it in the shell command", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(
          "Chunk ID: install\nProcess exited with code 0\nOutput:\n",
        )
        .mockResolvedValueOnce(
          "Chunk ID: run\nProcess exited with code 0\nOutput:\n{\"type\":\"turn.completed\"}\n",
        ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;

    await expect(runCodexAutomation(session, input)).resolves.toEqual({
      eventStream:
        "Chunk ID: run\nProcess exited with code 0\nOutput:\n{\"type\":\"turn.completed\"}\n",
    });
    expect(session.materializeEntry).toHaveBeenCalledWith({
      entry: { type: "file", content: input.prompt },
      path: "/home/daytona/workspace/.responder/automation-prompt.txt",
    });
    const command = vi.mocked(session.execCommand).mock.calls[1]?.[0].cmd;
    expect(command).not.toContain(input.prompt);
    expect(command).toContain("trap");
  });

  it("does not include a customer provider key in command configuration", () => {
    const customerProviderKey = "customer-provider-key-for-test";
    const command = buildCodexAutomationCommand(input);
    const serializedInput = JSON.stringify(input);

    expect(command).not.toContain(customerProviderKey);
    expect(serializedInput).not.toContain(customerProviderKey);
  });

  it("returns a generic error instead of command output", async () => {
    const secretShapedOutput = "sk-customer-must-not-escape";
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(
          "Chunk ID: install\nProcess exited with code 0\nOutput:\n",
        )
        .mockResolvedValue(
          `Chunk ID: run\nProcess exited with code 1\nOutput:\n${secretShapedOutput}\n`,
        ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;

    const run = runCodexAutomation(session, input);
    await expect(run).rejects.toThrow(
      "Codex automation harness failed",
    );
    await expect(run).rejects.not.toThrow(secretShapedOutput);
  });
});
