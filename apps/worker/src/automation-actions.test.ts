import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "@responder/core/credentials/encryption";
import {
  automationActionsPath,
  executeAutomationActions,
} from "./automation-actions.js";

const runId = "21212121-2121-4121-8121-212121212121";
const versionId = "41414141-4141-4141-8141-414141414141";

function session(manifest: unknown) {
  return {
    pathExists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue(
      new TextEncoder().encode(JSON.stringify(manifest)),
    ),
  } as unknown as DaytonaSandboxSession;
}

function dependencies() {
  return {
    beginAttempt: vi.fn().mockResolvedValue({ id: "attempt-1", status: "started" }),
    completeAttempt: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({
      branch: "fix/example-attempt",
      changedFiles: ["src/index.ts"],
      number: 1,
      url: "https://github.com/acme/app/pull/1",
    }),
    failAttempt: vi.fn().mockResolvedValue(undefined),
    getConnections: vi.fn().mockResolvedValue([]),
    getRepositories: vi.fn().mockResolvedValue([{
      defaultBranch: "main",
      fullName: "acme/app",
      installationId: 123,
      private: true,
    }]),
    openDirectMessage: vi.fn().mockResolvedValue("D123"),
    postMessage: vi.fn().mockResolvedValue("171234.001"),
  };
}

const checkout = {
  branch: "main",
  path: "/home/daytona/workspace/repositories/acme/app",
  repository: "acme/app",
  sha: "a".repeat(40),
  workspaceBaseSha: "a".repeat(40),
};

describe("automation trusted actions", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("publishes a pull request only for a selected checked-out repository", async () => {
    const deps = dependencies();
    const activeSession = session({ actions: [{
      body: "Fixes the deployment check.",
      id: "pr-1",
      kind: "open_github_pull_request",
      repository: "acme/app",
      title: "Fix deployment check",
    }] });

    await expect(executeAutomationActions({
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      runId,
      session: activeSession,
    }, deps)).resolves.toEqual([{
      externalReference: "https://github.com/acme/app/pull/1",
      kind: "open_github_pull_request",
    }]);

    expect(activeSession.readFile).toHaveBeenCalledWith({
      maxBytes: 200_000,
      path: automationActionsPath,
    });
    expect(deps.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 123,
        repository: "acme/app",
        requestId: "attempt-1",
      }),
      activeSession,
    );
    expect(deps.completeAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      externalReference: "https://github.com/acme/app/pull/1",
    });
  });

  it("reuses a completed action without repeating the external write", async () => {
    const deps = dependencies();
    deps.beginAttempt.mockResolvedValue({
      externalReference: "C123:171234.001",
      id: "attempt-1",
      status: "existing_succeeded",
    });
    const activeSession = session({ actions: [{
      id: "slack-1",
      integrationAccountId: "61616161-6161-4161-8161-616161616161",
      kind: "send_slack_message",
      target: { channelId: "C123", type: "channel" },
      text: "The fix is ready.",
    }] });

    await expect(executeAutomationActions({
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      runId,
      session: activeSession,
    }, deps)).resolves.toEqual([{
      externalReference: "C123:171234.001",
      kind: "send_slack_message",
    }]);
    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.completeAttempt).not.toHaveBeenCalled();
  });

  it("keeps Slack credentials on the worker while delivering a DM", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const deps = dependencies();
    deps.getConnections.mockResolvedValue([{
      encryptedCredentials: encryptCredentials({ accessToken: "xoxb-secret" }),
      externalAccountId: "T123",
      id: "61616161-6161-4161-8161-616161616161",
      metadata: {},
      provider: "slack",
    }]);
    const activeSession = session({ actions: [{
      id: "slack-1",
      kind: "send_slack_message",
      target: { type: "dm", userId: "U123" },
      text: "The fix is ready.",
    }] });

    await executeAutomationActions({
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      runId,
      session: activeSession,
    }, deps);

    expect(deps.openDirectMessage).toHaveBeenCalledWith({
      accessToken: "xoxb-secret",
      userId: "U123",
    });
    expect(deps.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "xoxb-secret",
      channelId: "D123",
      clientMessageId: "attempt-1",
    }));
    expect(JSON.stringify(activeSession)).not.toContain("xoxb-secret");
  });

  it("rejects duplicate action IDs without starting an external write", async () => {
    const deps = dependencies();
    const duplicate = {
      body: "Fixes the deployment check.",
      id: "same-action",
      kind: "open_github_pull_request",
      repository: "acme/app",
      title: "Fix deployment check",
    };
    await expect(executeAutomationActions({
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      runId,
      session: session({ actions: [duplicate, duplicate] }),
    }, deps)).rejects.toThrow("Action IDs must be unique");
    expect(deps.beginAttempt).not.toHaveBeenCalled();
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it("checks cancellation immediately before a trusted write", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const deps = dependencies();
    deps.getConnections.mockResolvedValue([{
      encryptedCredentials: encryptCredentials({ accessToken: "xoxb-secret" }),
      externalAccountId: "T123",
      id: "61616161-6161-4161-8161-616161616161",
      metadata: {},
      provider: "slack",
    }]);
    const controller = new AbortController();
    deps.openDirectMessage.mockImplementation(async () => {
      controller.abort(new Error("run cancelled"));
      return "D123";
    });
    await expect(executeAutomationActions({
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      runId,
      session: session({ actions: [{
        id: "slack-1",
        kind: "send_slack_message",
        target: { type: "dm", userId: "U123" },
        text: "The fix is ready.",
      }] }),
      signal: controller.signal,
    }, deps)).rejects.toThrow("run cancelled");
    expect(deps.postMessage).not.toHaveBeenCalled();
  });
});
