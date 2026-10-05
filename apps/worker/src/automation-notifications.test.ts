import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import {
  automationNotificationMessage,
  postAutomationNotification,
  sendAutomationRunNotifications,
} from "./automation-notifications.js";

vi.mock("@responder/core/credentials/encryption", () => ({
  decryptCredentials: vi.fn(() => ({ accessToken: "xoxb-token" })),
}));

const automationId = "31313131-3131-4131-8131-313131313131";
const organizationId = "15151515-1515-4515-8515-151515151515";
const runId = "21212121-2121-4121-8121-212121212121";
const notification = {
  channelId: "C999",
  integrationAccountId: "41414141-4141-4141-8141-414141414141",
  kind: "slack" as const,
};

describe("automation notification message", () => {
  it("posts the agent's final response with a link to the run", () => {
    expect(automationNotificationMessage({
      automationName: "Weekly digest",
      outcome: { message: "## Open issues\n- PROD-15 has no fix yet.", status: "succeeded" },
      runUrl: "https://responder.example/automations/a/runs/r",
    })).toEqual({
      markdown: "**Weekly digest** finished.\n\n## Open issues\n- PROD-15 has no fix yet.\n\n[View run](https://responder.example/automations/a/runs/r)",
      text: "Weekly digest finished",
    });
  });

  it("explains a failed run", () => {
    expect(automationNotificationMessage({
      automationName: "Weekly digest",
      outcome: { message: "Automation run exceeded its configured runtime limit", status: "failed" },
      runUrl: null,
    })).toEqual({
      markdown: "**Weekly digest** failed: Automation run exceeded its configured runtime limit",
      text: "Weekly digest failed",
    });
  });

  it("stays within Slack's markdown block limit and keeps the link", () => {
    const { markdown } = automationNotificationMessage({
      automationName: "Weekly digest",
      outcome: { message: "x".repeat(20_000), status: "succeeded" },
      runUrl: "https://responder.example/r",
    });
    expect(markdown.length).toBeLessThanOrEqual(12_000);
    expect(markdown).toMatch(/…\n\n\[View run\]\(https:\/\/responder\.example\/r\)$/u);
  });
});

describe("sending automation notifications", () => {
  afterEach(() => vi.clearAllMocks());

  function send(overrides: Partial<Parameters<typeof sendAutomationRunNotifications>[1]> = {}) {
    const dependencies = {
      getAccount: vi.fn().mockResolvedValue({ encryptedCredentials: "encrypted" }),
      post: vi.fn().mockResolvedValue("1790000000.000100"),
      ...overrides,
    };
    const onError = vi.fn().mockResolvedValue(undefined);
    return {
      dependencies,
      onError,
      sent: sendAutomationRunNotifications({
        automationId,
        automationName: "Weekly digest",
        environment: { RESPONDER_APP_URL: "https://responder.example" },
        notifications: [notification, { ...notification, channelId: "C888" }],
        onError,
        organizationId,
        outcome: { message: "All clear.", status: "succeeded" },
        runId,
      }, dependencies),
    };
  }

  it("posts to each channel through its Slack connection", async () => {
    const { dependencies, sent } = send();
    await sent;

    expect(dependencies.getAccount).toHaveBeenCalledWith({
      integrationAccountId: notification.integrationAccountId,
      organizationId,
    });
    expect(decryptCredentials).toHaveBeenCalledWith("encrypted");
    expect(dependencies.post).toHaveBeenCalledTimes(2);
    expect(dependencies.post).toHaveBeenCalledWith({
      accessToken: "xoxb-token",
      blocks: [{
        text: `**Weekly digest** finished.\n\nAll clear.\n\n[View run](https://responder.example/automations/${automationId}/runs/${runId}?organization_id=${organizationId})`,
        type: "markdown",
      }],
      channelId: "C999",
      clientMessageId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u),
      text: "Weekly digest finished",
    });
    const ids = vi.mocked(dependencies.post).mock.calls.map(([input]) => input.clientMessageId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("replies in a thread", async () => {
    const post = vi.fn().mockResolvedValue("1790000000.000200");
    await postAutomationNotification({
      markdown: "Details.",
      notifications: [notification],
      organizationId,
      seed: "attempt-1:1",
      text: "Details.",
      threadTimestamp: "1790000000.000100",
    }, { getAccount: vi.fn().mockResolvedValue({ encryptedCredentials: "encrypted" }), post });

    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C999",
      threadTimestamp: "1790000000.000100",
    }));
  });

  it("adds buttons under the message", async () => {
    const post = vi.fn().mockResolvedValue("1790000000.000200");
    const buttonsBlock = { block_id: "automation_run_buttons", elements: [], type: "actions" };
    await postAutomationNotification({
      buttonsBlock,
      markdown: "Checkout fails.",
      notifications: [notification],
      organizationId,
      seed: "attempt-1",
      text: "Checkout fails.",
    }, { getAccount: vi.fn().mockResolvedValue({ encryptedCredentials: "encrypted" }), post });

    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [{ text: "Checkout fails.", type: "markdown" }, buttonsBlock],
    }));
  });

  it("reports a turn that answered a button in that message's thread", async () => {
    const post = vi.fn().mockResolvedValue("1790000000.000300");
    const dependencies = { getAccount: vi.fn().mockResolvedValue({ encryptedCredentials: "encrypted" }), post };
    const report = (eventId: number) => sendAutomationRunNotifications({
      automationId,
      automationName: "Sentry triage",
      environment: {},
      notifications: [notification],
      onError: vi.fn(),
      organizationId,
      outcome: { message: "Opened the pull request.", status: "succeeded" },
      runId,
      thread: { eventId, timestamp: "1790000000.000100" },
    }, dependencies);

    await report(2);
    await report(5);

    expect(post).toHaveBeenCalledWith(expect.objectContaining({ threadTimestamp: "1790000000.000100" }));
    // Each turn's report is its own Slack message.
    const ids = post.mock.calls.map(([input]) => input.clientMessageId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("keeps posting to other channels when one fails", async () => {
    const failure = new Error("not_in_channel");
    const { dependencies, onError, sent } = send({
      post: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue("1790000000.000100"),
    });
    await sent;

    expect(onError).toHaveBeenCalledWith(notification, failure);
    expect(dependencies.post).toHaveBeenCalledTimes(2);
  });

  it("reports a disconnected Slack workspace", async () => {
    const { dependencies, onError, sent } = send({ getAccount: vi.fn().mockResolvedValue(null) });
    await sent;

    expect(dependencies.post).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(notification, expect.objectContaining({
      message: "The Slack connection is unavailable",
    }));
  });
});
