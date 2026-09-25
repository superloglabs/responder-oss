import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { AutomationHarnessError } from "./automation-harness.js";
import {
  buildCodexAutomationCommand,
  codexCliVersion,
  prepareCodexAutomationHarness,
  runCodexAutomation,
} from "./codex-automation-harness.js";

const input = {
  contextServers: [
    {
      name: "slack_61616161616141618161616161616161",
      url: "https://responder.test/api/automation-context-broker/v1/61616161-6161-4161-8161-616161616161",
    },
  ],
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
      execCommand: vi
        .fn()
        .mockResolvedValue(
          "Chunk ID: install\nProcess exited with code 0\nOutput:\n",
        ),
    } as unknown as DaytonaSandboxSession;

    await expect(
      prepareCodexAutomationHarness(session),
    ).resolves.toBe(`/home/daytona/workspace/.responder/codex/${codexCliVersion}/node_modules/.bin/codex`);

    expect(session.execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining(`@openai/codex@${codexCliVersion}`),
        workdir: "/home/daytona/workspace",
      }),
    );
    const command = vi.mocked(session.execCommand).mock.calls[0]?.[0].cmd;
    expect(command).toContain("unset RESPONDER_MODEL_BROKER_TOKEN");
    expect(command?.indexOf("unset RESPONDER_MODEL_BROKER_TOKEN")).toBeLessThan(
      command?.indexOf("npm install") ?? -1,
    );
    expect(command).toContain("process.versions.node");
  });

  it("uses the snapshot's prebuilt CLI when it has the pinned version", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: install\nProcess exited with code 0\nOutput:\nresponder-harness=prebuilt\n",
      ),
    } as unknown as DaytonaSandboxSession;

    await expect(prepareCodexAutomationHarness(session)).resolves.toBe(
      `/opt/responder/codex/${codexCliVersion}/node_modules/.bin/codex`,
    );
    expect(buildCodexAutomationCommand(input, `/opt/responder/codex/${codexCliVersion}/node_modules/.bin/codex`))
      .toContain(`'/opt/responder/codex/${codexCliVersion}/node_modules/.bin/codex' 'exec'`);
  });

  it("writes events to a file while it runs and prints them at the end", () => {
    const command = buildCodexAutomationCommand({
      ...input,
      eventsPath: "/home/daytona/workspace/.responder/harness-events-1.jsonl",
    });
    expect(command).toContain("> '/home/daytona/workspace/.responder/harness-events-1.jsonl' || harness_status=$?");
    expect(command.trimEnd().split("\n").slice(-2)).toEqual([
      "cat '/home/daytona/workspace/.responder/harness-events-1.jsonl'",
      'exit "$harness_status"',
    ]);
    expect(() => buildCodexAutomationCommand({ ...input, eventsPath: "/tmp/events.jsonl" }))
      .toThrow("inside the sandbox workspace");
  });

  it("fails safely when the pinned CLI cannot be prepared", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValue(
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
    expect(command).toContain('shell_environment_policy.inherit="core"');
    expect(command).toContain(
      "shell_environment_policy.ignore_default_excludes=false",
    );
    expect(command).toContain(
      'shell_environment_policy.filters={ RESPONDER_MODEL_BROKER_TOKEN = "exclude" }',
    );
    expect(command).toContain(
      "mcp_servers.slack_61616161616141618161616161616161.url",
    );
    expect(command).toContain("bearer_token_env_var");
    expect(command).toContain(
      'mcp_servers.slack_61616161616141618161616161616161.default_tools_approval_mode="approve"',
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
          "Chunk ID: workspace\nProcess exited with code 0\nOutput:\n",
        )
        .mockResolvedValueOnce(
          'Chunk ID: run\nProcess exited with code 0\nOutput:\n{"type":"turn.completed"}\n',
        ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;

    await expect(runCodexAutomation(session, input)).resolves.toEqual({
      eventStream:
        'Chunk ID: run\nProcess exited with code 0\nOutput:\n{"type":"turn.completed"}\n',
    });
    expect(session.materializeEntry).toHaveBeenCalledWith({
      entry: { type: "file", content: input.prompt },
      path: "/home/daytona/workspace/.responder/automation-prompt.txt",
    });
    const command = vi.mocked(session.execCommand).mock.calls[2]?.[0].cmd;
    expect(command).not.toContain(input.prompt);
    expect(command).toContain("trap");
  });

  it("rejects a workspace redirected through a symlink before writing the prompt", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(
          "Chunk ID: workspace\nProcess exited with code 1\nOutput:\n",
        ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;

    await expect(runCodexAutomation(session, input)).rejects.toThrow(
      "Automation workspace cannot use symlink redirects",
    );
    expect(session.materializeEntry).not.toHaveBeenCalled();
  });

  it("reports a missing workspace separately from a symlink redirect", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(
          "Chunk ID: workspace\nProcess exited with code 42\nOutput:\n",
        ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;

    await expect(runCodexAutomation(session, input)).rejects.toThrow(
      "Automation workspace does not exist",
    );
    expect(session.materializeEntry).not.toHaveBeenCalled();
  });

  it("returns a generic error instead of command output", async () => {
    const secretShapedOutput = "sk-customer-must-not-escape";
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(
          "Chunk ID: install\nProcess exited with code 0\nOutput:\n",
        )
        .mockResolvedValueOnce(
          "Chunk ID: workspace\nProcess exited with code 0\nOutput:\n",
        )
        .mockResolvedValue(
          `Chunk ID: run\nProcess exited with code 1\nOutput:\n${secretShapedOutput}\n`,
        ),
      materializeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaytonaSandboxSession;

    const run = runCodexAutomation(session, input);
    await expect(run).rejects.toThrow("Codex automation harness failed");
    await expect(run).rejects.not.toThrow(secretShapedOutput);
    // The output stays available for the run transcript.
    await expect(run).rejects.toBeInstanceOf(AutomationHarnessError);
    await expect(run).rejects.toHaveProperty("eventStream", expect.stringContaining("Process exited with code 1"));
  });
});

it("uses managed ChatGPT inference, persists refreshed auth, and removes the cache on failure", async () => {
  const authJson = JSON.stringify({
    tokens: {
      id_token: "id-token",
      access_token: "access-token",
      refresh_token: "refresh-token",
      account_id: "account",
    },
  });
  const persist = vi.fn().mockResolvedValue(undefined);
  const nativeInput = {
    ...input,
    model: { ...input.model, subscription: { authJson, persist } },
  };
  const command = buildCodexAutomationCommand(nativeInput);
  expect(command).toContain('forced_login_method="chatgpt"');
  expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(command).toContain('default_permissions="subscription"');
  expect(command).toContain(
    '"/home/daytona/.responder-subscription-auth"="deny"',
  );
  expect(command).not.toContain("model_providers.responder");
  expect(command).not.toContain("access-token");
  expect(command).toContain(
    "unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN",
  );
  const session = {
    execCommand: vi
      .fn()
      .mockResolvedValue("Process exited with code 0\n")
      .mockResolvedValueOnce("Process exited with code 0\n")
      .mockResolvedValueOnce("Process exited with code 0\n")
      .mockResolvedValueOnce("Process exited with code 0\n")
      .mockResolvedValueOnce("Process exited with code 1\n"),
    materializeEntry: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(new TextEncoder().encode(authJson)),
  } as unknown as DaytonaSandboxSession;
  await expect(runCodexAutomation(session, nativeInput)).rejects.toThrow(
    "harness failed",
  );
  expect(persist).toHaveBeenCalledWith(authJson);
  expect(session.materializeEntry).toHaveBeenCalledWith({
    entry: { type: "file", content: authJson },
    path: "/home/daytona/.responder-subscription-auth/auth.json",
    runAs: "root",
  });
  expect(session.execCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cmd: expect.stringContaining(
        "sudo -n rm -rf /home/daytona/.responder-subscription-auth",
      ),
    }),
  );
});

it("redacts native subscription tokens from persisted harness output", async () => {
  const authJson = JSON.stringify({
    tokens: {
      id_token: "secret-id",
      access_token: "secret-access",
      refresh_token: "secret-refresh",
      account_id: "account",
    },
  });
  const session = {
    execCommand: vi
      .fn()
      .mockResolvedValue(
        "Process exited with code 0\nsecret-access secret-refresh secret-id",
      ),
    materializeEntry: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(new TextEncoder().encode(authJson)),
  } as unknown as DaytonaSandboxSession;
  const result = await runCodexAutomation(session, {
    ...input,
    model: {
      ...input.model,
      subscription: { authJson, persist: vi.fn().mockResolvedValue(undefined) },
    },
  });
  expect(result.eventStream).not.toContain("secret-");
  expect(result.eventStream).toContain("[redacted]");
});

it("removes native credentials when materialization fails", async () => {
  const authJson = JSON.stringify({
    tokens: {
      id_token: "id",
      access_token: "access",
      refresh_token: "refresh",
      account_id: "account",
    },
  });
  const session = {
    execCommand: vi.fn().mockResolvedValue("Process exited with code 0\n"),
    materializeEntry: vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("upload failed")),
    readFile: vi.fn().mockRejectedValue(new Error("missing")),
  } as unknown as DaytonaSandboxSession;
  await expect(
    runCodexAutomation(session, {
      ...input,
      model: { ...input.model, subscription: { authJson, persist: vi.fn() } },
    }),
  ).rejects.toThrow();
  expect(session.execCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cmd: expect.stringContaining(
        "sudo -n rm -rf /home/daytona/.responder-subscription-auth",
      ),
    }),
  );
});
