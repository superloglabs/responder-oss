import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  automationActionInstructions,
  createAutomationToolHandler,
} from "./automation-actions.js";

const runId = "21212121-2121-4121-8121-212121212121";
const versionId = "41414141-4141-4141-8141-414141414141";
const session = {} as DaytonaSandboxSession;

const checkout = {
  branch: "main",
  path: "/home/daytona/workspace/repositories/acme/app",
  repository: "acme/app",
  sha: "a".repeat(40),
  workspaceBaseSha: "a".repeat(40),
};

function dependencies() {
  return {
    beginAttempt: vi.fn().mockResolvedValue({ id: "attempt-1", status: "started" }),
    checkoutAtRef: vi.fn(),
    checkoutPullRequest: vi.fn().mockResolvedValue({
      checkout: { ...checkout, branch: "fix/example-attempt", sha: "c".repeat(40) },
      head: { branch: "fix/example-attempt", sha: "c".repeat(40), url: "https://github.com/acme/app/pull/1" },
      replaced: true,
    }),
    completeAttempt: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({
      branch: "fix/example-attempt",
      changedFiles: ["src/index.ts"],
      number: 1,
      url: "https://github.com/acme/app/pull/1",
    }),
    failAttempt: vi.fn().mockResolvedValue(undefined),
    getOwnedPullRequest: vi.fn().mockResolvedValue({
      branch: "fix/example-attempt",
      pullRequestNumber: 1,
      repositoryFullName: "acme/app",
    }),
    postNotification: vi.fn().mockResolvedValue([]),
    recordOrigin: vi.fn().mockResolvedValue(undefined),
    replyToComment: vi.fn().mockResolvedValue({ resolved: true }),
    updatePullRequest: vi.fn().mockResolvedValue({
      changedFiles: ["src/index.ts"],
      headSha: "d".repeat(40),
      url: "https://github.com/acme/app/pull/1",
    }),
    getRepositories: vi.fn().mockResolvedValue([{
      defaultBranch: "main",
      fullName: "acme/app",
      installationId: 123,
      private: true,
    }]),
  };
}

const openPullRequest = {
  arguments: {
    body: "Fixes the deployment check.",
    repository: "acme/app",
    title: "Fix deployment check",
  },
  name: "open_pull_request",
};

function handler(
  deps: ReturnType<typeof dependencies>,
  overrides: Partial<Parameters<typeof createAutomationToolHandler>[0]> = {},
) {
  const onAction = vi.fn().mockResolvedValue(undefined);
  return {
    handle: createAutomationToolHandler({
      automationVersionId: versionId,
      checkedOutRepositories: [checkout],
      onAction,
      organizationId: "organization-1",
      runId,
      session,
      ...overrides,
    }, deps),
    onAction,
  };
}

const resultText = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0]!.text) as Record<string, unknown>;

describe("automation pull request tool", () => {
  it("opens a pull request for a selected checked-out repository and returns its link", async () => {
    const deps = dependencies();
    const { handle, onAction } = handler(deps);

    const result = await handle(openPullRequest);

    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toEqual({
      branch: "fix/example-attempt",
      changedFiles: ["src/index.ts"],
      number: 1,
      repository: "acme/app",
      title: "Fix deployment check",
      url: "https://github.com/acme/app/pull/1",
    });
    expect(deps.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 123,
        repository: "acme/app",
        requestId: "attempt-1",
      }),
      session,
    );
    expect(deps.completeAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      externalReference: "https://github.com/acme/app/pull/1",
    });
    expect(onAction).toHaveBeenCalledWith({
      externalReference: "https://github.com/acme/app/pull/1",
      kind: "open_github_pull_request",
      repository: "acme/app",
      title: "Fix deployment check",
    });
  });

  it("returns the earlier pull request when the same one is requested again", async () => {
    const deps = dependencies();
    deps.beginAttempt.mockResolvedValue({
      externalReference: "https://github.com/acme/app/pull/1",
      id: "attempt-1",
      status: "existing_succeeded",
    });
    const { handle, onAction } = handler(deps);

    const result = await handle(openPullRequest);

    expect(resultText(result)).toMatchObject({ url: "https://github.com/acme/app/pull/1" });
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keys a pull request by repository and title", async () => {
    const deps = dependencies();
    const { handle } = handler(deps);

    await handle(openPullRequest);
    await handle({ ...openPullRequest, arguments: { ...openPullRequest.arguments, body: "Edited body." } });
    await handle({ ...openPullRequest, arguments: { ...openPullRequest.arguments, title: "Another fix" } });

    const keys = deps.beginAttempt.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("tells the agent why a pull request could not be opened", async () => {
    const deps = dependencies();
    deps.createPullRequest.mockRejectedValue(new Error("No repository changes were made"));
    const { handle, onAction } = handler(deps);

    await expect(handle(openPullRequest)).resolves.toEqual({
      content: [{
        text: "Unable to open the pull request: No repository changes were made",
        type: "text",
      }],
      isError: true,
    });
    expect(deps.failAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      failureMessage: "No repository changes were made",
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("refuses repositories that the automation did not select", async () => {
    const deps = dependencies();
    const { handle } = handler(deps);

    const result = await handle({
      ...openPullRequest,
      arguments: { ...openPullRequest.arguments, repository: "acme/other" },
    });

    expect(result).toMatchObject({ isError: true });
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it("rejects unknown tools and invalid arguments without starting a write", async () => {
    const deps = dependencies();
    const { handle } = handler(deps);

    await expect(handle({ arguments: {}, name: "merge_pull_request" })).resolves.toMatchObject({ isError: true });
    await expect(handle({ arguments: { repository: "acme/app" }, name: "open_pull_request" })).resolves.toMatchObject({ isError: true });
    expect(deps.beginAttempt).not.toHaveBeenCalled();
  });

  it("checks the run is active immediately before the write", async () => {
    const deps = dependencies();
    let checks = 0;
    const { handle } = handler(deps, {
      assertActive: async () => {
        checks += 1;
        if (checks === 2) throw new Error("run cancelled");
      },
    });

    await expect(handle(openPullRequest)).resolves.toMatchObject({ isError: true });
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.failAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      failureMessage: "run cancelled",
    });
  });
});

describe("automation notification tool", () => {
  const notification = {
    channelId: "C100",
    integrationAccountId: "61616161-6161-4161-8161-616161616161",
    kind: "slack" as const,
  };
  const target = (onPosted = vi.fn(), onSkipped = vi.fn().mockResolvedValue(undefined)) => ({
    channelNames: new Map([[`${notification.integrationAccountId}:C100`, "ops"]]),
    notifications: [notification],
    onPosted,
    onSkipped,
    organizationId: "15151515-1515-4515-8515-151515151515",
    runUrl: "https://responder.example/automations/a/runs/r",
  });

  it("posts the agent's report to the notification channels with a link to the run", async () => {
    const deps = dependencies();
    deps.postNotification.mockResolvedValue([{ notification, timestamp: "1790000000.000100" }]);
    const onPosted = vi.fn();
    const { handle, onAction } = handler(deps, { notifications: target(onPosted) });

    const result = await handle({ arguments: { text: "## Weekly digest\nAll clear." }, name: "post_notification" });

    expect(resultText(result)).toEqual({ posted: ["#ops"] });
    expect(deps.postNotification).toHaveBeenCalledWith({
      markdown: "## Weekly digest\nAll clear.\n\n[View run](https://responder.example/automations/a/runs/r)",
      notifications: [notification],
      organizationId: "15151515-1515-4515-8515-151515151515",
      seed: "attempt-1",
      text: "Weekly digest",
    });
    expect(deps.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      kind: "send_slack_message",
      redactedInput: { channel: "#ops" },
      toolCallId: "post_notification",
    }));
    expect(onAction).toHaveBeenCalledWith({ externalReference: "C100:1790000000.000100", kind: "send_slack_message" });
    expect(onPosted).toHaveBeenCalledWith(notification);
  });

  it("posts details as replies in the new message's thread", async () => {
    const deps = dependencies();
    deps.postNotification.mockResolvedValue([{ notification, timestamp: "1790000000.000100" }]);
    const { handle } = handler(deps, { notifications: target() });

    const result = await handle({
      arguments: { details: ["## Root cause\nA null check.", "## Fix\nOpened a pull request."], text: "New issue triaged." },
      name: "post_notification",
    });

    expect(resultText(result)).toEqual({ posted: ["#ops"] });
    expect(deps.postNotification).toHaveBeenCalledTimes(3);
    expect(deps.postNotification.mock.calls[1]![0]).toEqual({
      markdown: "## Root cause\nA null check.",
      notifications: [notification],
      organizationId: "15151515-1515-4515-8515-151515151515",
      seed: "attempt-1:1",
      text: "Root cause",
      threadTimestamp: "1790000000.000100",
    });
    expect(deps.postNotification.mock.calls[2]![0]).toMatchObject({
      markdown: "## Fix\nOpened a pull request.",
      seed: "attempt-1:2",
      threadTimestamp: "1790000000.000100",
    });
  });

  it("adds buttons that continue the run and records their labels", async () => {
    const deps = dependencies();
    deps.postNotification.mockResolvedValue([{ notification, timestamp: "1790000000.000100" }]);
    const { handle } = handler(deps, { notifications: target() });

    await handle({
      arguments: { buttons: [{ label: "Create PR", style: "primary" }, { label: "Ignore" }], text: "Checkout fails for guests." },
      name: "post_notification",
    });

    expect(deps.postNotification).toHaveBeenCalledWith(expect.objectContaining({
      buttonsBlock: {
        block_id: "automation_run_buttons",
        elements: [
          { action_id: "automation_run_button:0", style: "primary", text: { emoji: true, text: "Create PR", type: "plain_text" }, type: "button", value: runId },
          { action_id: "automation_run_button:1", text: { emoji: true, text: "Ignore", type: "plain_text" }, type: "button", value: runId },
        ],
        type: "actions",
      },
    }));
    expect(deps.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      redactedInput: {
        buttons: ["Create PR", "Ignore"],
        channel: "#ops",
        channelId: "C100",
        integrationAccountId: notification.integrationAccountId,
      },
    }));
  });

  it("refuses more buttons than Slack shows or repeated labels", async () => {
    const deps = dependencies();
    const { handle } = handler(deps, { notifications: target() });

    for (const buttons of [
      Array.from({ length: 6 }, (_, index) => ({ label: `Option ${index}` })),
      [{ label: "Yes" }, { label: "Yes" }],
    ]) {
      await expect(handle({ arguments: { buttons, text: "Choose." }, name: "post_notification" }))
        .resolves.toMatchObject({ isError: true });
    }
    expect(deps.postNotification).not.toHaveBeenCalled();

    deps.postNotification.mockResolvedValue([{ notification, timestamp: "1790000000.000100" }]);
    const five = Array.from({ length: 5 }, (_, index) => ({ label: `Option ${index}` }));
    await expect(handle({ arguments: { buttons: five, text: "Choose." }, name: "post_notification" }))
      .resolves.not.toMatchObject({ isError: true });
    expect(deps.postNotification).toHaveBeenCalledOnce();
  });

  it("replies in the thread of a pressed button's message", async () => {
    const deps = dependencies();
    deps.postNotification.mockResolvedValue([{ notification, timestamp: "1790000002.000100" }]);
    const { handle } = handler(deps, { notifications: { ...target(), threadTimestamp: "1790000001.000100" } });

    await handle({ arguments: { details: ["The diff."], text: "Opened the pull request." }, name: "post_notification" });

    expect(deps.postNotification.mock.calls.map(([input]) => input.threadTimestamp))
      .toEqual(["1790000001.000100", "1790000001.000100"]);
  });

  it("keeps the posted message and reports a reply that failed", async () => {
    const deps = dependencies();
    deps.postNotification
      .mockResolvedValueOnce([{ notification, timestamp: "1790000000.000100" }])
      .mockResolvedValueOnce([{ error: new Error("rate_limited"), notification }]);
    const onPosted = vi.fn();
    const { handle } = handler(deps, { notifications: target(onPosted) });

    const result = await handle({
      arguments: { details: ["First.", "Second."], text: "New issue triaged." },
      name: "post_notification",
    });

    // The second reply is not posted out of order.
    expect(deps.postNotification).toHaveBeenCalledTimes(2);
    expect(resultText(result)).toEqual({
      failed: [{ channel: "#ops thread reply 1", error: "rate_limited" }],
      posted: ["#ops"],
    });
    expect(deps.completeAttempt).toHaveBeenCalled();
    expect(onPosted).toHaveBeenCalledWith(notification);
  });

  it("does not post the same report twice", async () => {
    const deps = dependencies();
    deps.beginAttempt.mockResolvedValue({ externalReference: "C100:1", id: "attempt-1", status: "existing_succeeded" });
    const onPosted = vi.fn();
    const { handle } = handler(deps, { notifications: target(onPosted) });

    const result = await handle({ arguments: { text: "All clear." }, name: "post_notification" });

    expect(resultText(result)).toEqual({ alreadyPosted: ["#ops"], posted: [] });
    expect(deps.postNotification).not.toHaveBeenCalled();
    expect(onPosted).toHaveBeenCalledWith(notification);
  });

  it("reports channels it could not post to", async () => {
    const deps = dependencies();
    deps.postNotification.mockResolvedValue([{ error: new Error("not_in_channel"), notification }]);
    const onPosted = vi.fn();
    const { handle } = handler(deps, { notifications: target(onPosted) });

    await expect(handle({ arguments: { text: "All clear." }, name: "post_notification" })).resolves.toEqual({
      content: [{ text: "Unable to post the notification: #ops: not_in_channel", type: "text" }],
      isError: true,
    });
    expect(deps.failAttempt).toHaveBeenCalled();
    expect(onPosted).not.toHaveBeenCalled();
  });

  it("retries only the channels a post did not reach", async () => {
    const second = { ...notification, channelId: "C200" };
    const deps = dependencies();
    // Each channel is its own attempt; the first post reached only #ops.
    const attempts = new Map<string, { externalReference?: string; status: string }>();
    deps.beginAttempt.mockImplementation(async ({ idempotencyKey }: { idempotencyKey: string }) => {
      const existing = attempts.get(idempotencyKey);
      if (existing?.status === "succeeded") return { externalReference: existing.externalReference, id: idempotencyKey, status: "existing_succeeded" };
      return { id: idempotencyKey, status: "started" };
    });
    deps.completeAttempt.mockImplementation(async ({ attemptId, externalReference }: { attemptId: string; externalReference: string }) => {
      attempts.set(attemptId, { externalReference, status: "succeeded" });
    });
    deps.postNotification
      .mockResolvedValueOnce([{ notification, timestamp: "1.1" }])
      .mockResolvedValueOnce([{ error: new Error("not_in_channel"), notification: second }])
      .mockResolvedValueOnce([{ notification: second, timestamp: "2.2" }]);
    const onPosted = vi.fn();
    const { handle } = handler(deps, {
      notifications: { ...target(onPosted), notifications: [notification, second] },
    });

    const first = await handle({ arguments: { text: "All clear." }, name: "post_notification" });
    expect(resultText(first)).toMatchObject({ failed: [{ channel: "#C200", error: "not_in_channel" }], posted: ["#ops"] });
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(onPosted).toHaveBeenLastCalledWith(notification);

    const retry = await handle({ arguments: { text: "All clear." }, name: "post_notification" });
    expect(resultText(retry)).toEqual({ alreadyPosted: ["#ops"], posted: ["#C200"] });
    expect(deps.postNotification).toHaveBeenCalledTimes(3);
    expect(deps.postNotification.mock.calls[2]![0].notifications).toEqual([second]);
    expect(onPosted).toHaveBeenLastCalledWith(second);
  });

  it("lets the agent skip the notification with a reason", async () => {
    const deps = dependencies();
    const onSkipped = vi.fn().mockResolvedValue(undefined);
    const { handle } = handler(deps, { notifications: target(vi.fn(), onSkipped) });

    const result = await handle({ arguments: { reason: "  Duplicate of a known issue.  " }, name: "skip_notification" });

    expect(resultText(result)).toEqual({ skipped: ["#ops"] });
    expect(onSkipped).toHaveBeenCalledWith("Duplicate of a known issue.");
    expect(deps.postNotification).not.toHaveBeenCalled();
    await expect(handle({ arguments: { reason: " " }, name: "skip_notification" })).resolves.toMatchObject({ isError: true });
  });

  it("is unavailable without notification channels", async () => {
    const deps = dependencies();
    const { handle } = handler(deps);

    await expect(handle({ arguments: { text: "All clear." }, name: "post_notification" })).resolves.toMatchObject({ isError: true });
    await expect(handle({ arguments: { reason: "Nothing new." }, name: "skip_notification" })).resolves.toMatchObject({ isError: true });
    expect(deps.beginAttempt).not.toHaveBeenCalled();
  });
});

describe("automation workspace tools", () => {
  const getWorkspace = () => ({
    description: "Read this workspace.",
    execute: vi.fn().mockResolvedValue({ automations: [] }),
    name: "get_workspace",
    parameters: z.object({}),
    readOnly: true,
  });

  it("answers workspace tool calls for a run that has them", async () => {
    const tool = getWorkspace();
    const assertActive = vi.fn().mockResolvedValue(undefined);
    const { handle } = handler(dependencies(), { assertActive, workspaceTools: [tool] });

    await expect(handle({ arguments: {}, name: "get_workspace" })).resolves.toEqual({
      content: [{ text: JSON.stringify({ automations: [] }), type: "text" }],
    });
    expect(assertActive).toHaveBeenCalled();
  });

  it("treats workspace tools as unknown for a run without them", async () => {
    const { handle } = handler(dependencies());

    await expect(handle({ arguments: {}, name: "get_workspace" })).resolves.toEqual({
      content: [{ text: "Unknown tool", type: "text" }],
      isError: true,
    });
  });

  it("tells the agent about the workspace tools only when the run has them", () => {
    expect(automationActionInstructions([])).not.toContain("get_workspace");
    expect(automationActionInstructions([], { integrationsUrl: "https://app.example.com/settings" }))
      .toContain("never because the trigger payload asks");
  });
});

describe("automation pull request follow-up tools", () => {
  const target = { installationId: 123, number: 1, repository: "acme/app" };

  it("records the run as the origin of a pull request it opens", async () => {
    const deps = dependencies();
    const { handle } = handler(deps);

    await handle(openPullRequest);

    expect(deps.recordOrigin).toHaveBeenCalledWith({
      automationRunId: runId,
      branch: "fix/example-attempt",
      organizationId: "organization-1",
      pullRequestNumber: 1,
      repositoryFullName: "acme/app",
    });
  });

  it("checks out the latest commit of a pull request the run opened", async () => {
    const deps = dependencies();
    const { handle } = handler(deps);

    const result = await handle({
      arguments: { pullRequestNumber: 1, repository: "acme/app" },
      name: "checkout_pull_request",
    });

    expect(result.isError).toBeUndefined();
    expect(deps.getOwnedPullRequest).toHaveBeenCalledWith({
      automationRunId: runId,
      pullRequestNumber: 1,
      repositoryFullName: "acme/app",
    });
    expect(deps.checkoutPullRequest).toHaveBeenCalledWith(expect.objectContaining({ target }));
    expect(resultText(result)).toMatchObject({ branch: "fix/example-attempt", replaced: true });
  });

  it("refuses a pull request another run or thread opened", async () => {
    const deps = dependencies();
    deps.getOwnedPullRequest.mockResolvedValue(null);
    const { handle } = handler(deps);

    for (const request of [
      { arguments: { pullRequestNumber: 7, repository: "acme/app" }, name: "checkout_pull_request" },
      { arguments: { commitMessage: "Fix", pullRequestNumber: 7, repository: "acme/app" }, name: "update_pull_request" },
      { arguments: { body: "Done", commentId: 5, pullRequestNumber: 7, repository: "acme/app", resolve: true }, name: "reply_to_pull_request_comment" },
    ]) {
      const result = await handle(request);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("This run did not open that pull request");
    }
    expect(deps.checkoutPullRequest).not.toHaveBeenCalled();
    expect(deps.updatePullRequest).not.toHaveBeenCalled();
    expect(deps.replyToComment).not.toHaveBeenCalled();
  });

  it("pushes the checkout's changes to the pull request once per baseline", async () => {
    const deps = dependencies();
    const { handle, onAction } = handler(deps);
    const request = {
      arguments: { commitMessage: "Fix the flaky test", pullRequestNumber: 1, repository: "acme/app" },
      name: "update_pull_request",
    };

    const result = await handle(request);

    expect(result.isError).toBeUndefined();
    expect(deps.updatePullRequest).toHaveBeenCalledWith(expect.objectContaining({
      commitMessage: "Fix the flaky test",
      target,
    }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "update_github_pull_request" }));
    expect(deps.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      kind: "update_github_pull_request",
      toolCallId: "update_pull_request",
    }));

    deps.beginAttempt.mockResolvedValue({
      externalReference: "https://github.com/acme/app/pull/1",
      id: "attempt-1",
      status: "existing_succeeded",
    });
    const repeated = await handle(request);
    expect(resultText(repeated)).toMatchObject({ note: "These changes were already pushed." });
    expect(deps.updatePullRequest).toHaveBeenCalledTimes(1);
  });

  it("reports a failed push to the agent and records the failure", async () => {
    const deps = dependencies();
    deps.updatePullRequest.mockRejectedValue(new Error("Pull request #1 has commits the checkout does not have."));
    const { handle } = handler(deps);

    const result = await handle({
      arguments: { commitMessage: "Fix", pullRequestNumber: 1, repository: "acme/app" },
      name: "update_pull_request",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("has commits the checkout does not have");
    expect(deps.failAttempt).toHaveBeenCalled();
  });

  it("replies to a review comment and resolves its thread", async () => {
    const deps = dependencies();
    const { handle } = handler(deps);

    const result = await handle({
      arguments: { body: "Fixed in the latest commit.", commentId: 5, pullRequestNumber: 1, repository: "acme/app", resolve: true },
      name: "reply_to_pull_request_comment",
    });

    expect(result.isError).toBeUndefined();
    expect(deps.replyToComment).toHaveBeenCalledWith({
      body: "Fixed in the latest commit.",
      commentId: 5,
      resolve: true,
      target,
    });
  });
});
