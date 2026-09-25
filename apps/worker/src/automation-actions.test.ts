import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
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
    getRepositories: vi.fn().mockResolvedValue([{
      defaultBranch: "main",
      fullName: "acme/app",
      installationId: 123,
      private: true,
    }]),
  };
}

const checkout = {
  branch: "main",
  path: "/home/daytona/workspace/repositories/acme/app",
  repository: "acme/app",
  sha: "a".repeat(40),
  workspaceBaseSha: "a".repeat(40),
};

const pullRequestAction = {
  body: "Fixes the deployment check.",
  id: "pr-1",
  kind: "open_github_pull_request",
  repository: "acme/app",
  title: "Fix deployment check",
};

describe("automation trusted actions", () => {
  it("publishes a pull request only for a selected checked-out repository", async () => {
    const deps = dependencies();
    const activeSession = session({ actions: [pullRequestAction] });

    await expect(executeAutomationActions({
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      runId,
      session: activeSession,
    }, deps)).resolves.toEqual([{
      externalReference: "https://github.com/acme/app/pull/1",
      kind: "open_github_pull_request",
      repository: "acme/app",
      title: "Fix deployment check",
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
      externalReference: "https://github.com/acme/app/pull/1",
      id: "attempt-1",
      status: "existing_succeeded",
    });

    await expect(executeAutomationActions({
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      runId,
      session: session({ actions: [pullRequestAction] }),
    }, deps)).resolves.toEqual([{
      externalReference: "https://github.com/acme/app/pull/1",
      kind: "open_github_pull_request",
      repository: "acme/app",
      title: "Fix deployment check",
    }]);
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.completeAttempt).not.toHaveBeenCalled();
  });

  it("rejects Slack messages, which are live tools", async () => {
    const deps = dependencies();
    await expect(executeAutomationActions({
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      runId,
      session: session({ actions: [{
        id: "slack-1",
        kind: "send_slack_message",
        target: { channelId: "C123", type: "channel" },
        text: "The fix is ready.",
      }] }),
    }, deps)).rejects.toThrow();
    expect(deps.beginAttempt).not.toHaveBeenCalled();
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

  it("checks the run is active immediately before a trusted write", async () => {
    const deps = dependencies();
    let checks = 0;
    await expect(executeAutomationActions({
      assertActive: async () => {
        checks += 1;
        if (checks === 2) throw new Error("run cancelled");
      },
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      runId,
      session: session({ actions: [pullRequestAction] }),
    }, deps)).rejects.toThrow("run cancelled");
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.failAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      failureMessage: "run cancelled",
    });
  });
});
