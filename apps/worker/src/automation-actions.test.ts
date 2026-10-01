import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { createAutomationToolHandler } from "./automation-actions.js";

const runId = "21212121-2121-4121-8121-212121212121";
const versionId = "41414141-4141-4141-8141-414141414141";
const session = {} as DaytonaSandboxSession;

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
    postNotification: vi.fn().mockResolvedValue([]),
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
