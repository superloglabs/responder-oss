import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureAnalyticsEvent: vi.fn(),
  decryptCredentials: vi.fn(),
  getInvestigationForSlackAction: vi.fn(),
  getIssueForSlackAction: vi.fn(),
  postSlackEphemeralMessage: vi.fn(),
  removeInvestigationSlackReply: vi.fn(),
}));

vi.mock("@responder/core/analytics", () => ({
  captureAnalyticsEvent: mocks.captureAnalyticsEvent,
}));
vi.mock("../../../../packages/core/src/credentials/encryption.js", () => ({
  decryptCredentials: mocks.decryptCredentials,
}));
vi.mock(
  "../../../../packages/core/src/db/investigations.js",
  async (importOriginal) => ({
    ...(await importOriginal()),
    getInvestigationForSlackAction: mocks.getInvestigationForSlackAction,
    removeInvestigationSlackReply: mocks.removeInvestigationSlackReply,
  }),
);
vi.mock("../../../../packages/core/src/db/issues.js", () => ({
  getIssueForSlackAction: mocks.getIssueForSlackAction,
}));
vi.mock("../../../../packages/core/src/integrations/slack.js", async (importOriginal) => ({
  ...(await importOriginal()),
  postSlackEphemeralMessage: mocks.postSlackEphemeralMessage,
}));

import { slackWebhookRoutes } from "./slack.js";

const app = new Hono().route("/api/webhooks/slack", slackWebhookRoutes);

function signedActionRequest(payload: unknown) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = `v0=${createHmac("sha256", "slack-signing-secret")
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return app.request("/api/webhooks/slack/actions", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
  });
}

describe("Slack actions", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    mocks.getInvestigationForSlackAction.mockResolvedValue({
      agentId: "13131313-1313-4313-8313-131313131313",
      id: "16161616-1616-4616-8616-161616161616",
      organizationId: "03030303-0303-4303-8303-030303030303",
    });
    mocks.getIssueForSlackAction.mockResolvedValue({
      id: "07070707-0707-4707-8707-070707070707",
      title: "Plant API returns HTTP 500",
      description: "The plants endpoint is failing.",
      severity: "SEV-2",
      remediation: "Handle missing plant records.",
      remediations: [{
        id: "09090909-0909-4909-8909-090909090909",
        type: "code_change",
        title: "Handle missing plant records",
        description: "Guard missing plant records before using them.",
        changes: [{ repository: null, diff: "diff --git a/src/plants.ts b/src/plants.ts\n--- a/src/plants.ts\n+++ b/src/plants.ts\n@@ -1 +1 @@\n-old\n+new" }],
      }],
      evidence: [],
      organizationId: "03030303-0303-4303-8303-030303030303",
      encryptedCredentials: "encrypted-slack-token",
    });
    mocks.decryptCredentials.mockReturnValue({ accessToken: "xoxb-test" });
    mocks.captureAnalyticsEvent.mockResolvedValue(undefined);
    mocks.postSlackEphemeralMessage.mockResolvedValue("1785500002.000300");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("captures investigation feedback with workspace and user context", async () => {
    const investigationId = "16161616-1616-4616-8616-161616161616";
    const response = await signedActionRequest({
      type: "block_actions",
      team: { id: "T123" },
      channel: { id: "C123" },
      user: { id: "U123", name: "Ada Lovelace", username: "ada" },
      response_url: "https://hooks.slack.com/actions/T123/B123/response-token",
      message: { ts: "1785500001.000200" },
      actions: [
        {
          action_id: "feedback",
          block_id: `investigation_feedback_${investigationId}_card-version`,
          value: "positive",
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(mocks.getInvestigationForSlackAction).toHaveBeenCalledWith({
      investigationId,
      teamId: "T123",
    });
    expect(mocks.captureAnalyticsEvent).toHaveBeenCalledWith({
      distinctId: "slack:T123:U123",
      event: "investigation feedback submitted",
      organizationId: "03030303-0303-4303-8303-030303030303",
      properties: {
        $process_person_profile: false,
        agent_id: "13131313-1313-4313-8313-131313131313",
        channel_id: "C123",
        feedback: "positive",
        investigation_id: investigationId,
        message_timestamp: "1785500001.000200",
        slack_user_id: "U123",
        surface: "slack",
        team_id: "T123",
        user_name: "Ada Lovelace",
      },
    });
  });

  it("removes an investigation message from its feedback controls", async () => {
    const investigationId = "16161616-1616-4616-8616-161616161616";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await signedActionRequest({
      type: "block_actions",
      team: { id: "T123" },
      channel: { id: "C123" },
      user: { id: "U123" },
      response_url: "https://hooks.slack.com/actions/T123/B123/response-token",
      message: { ts: "1785500001.000200" },
      actions: [
        {
          action_id: "remove",
          block_id: `investigation_feedback_${investigationId}_card-version`,
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/actions/T123/B123/response-token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete_original: true }),
      },
    );
    expect(mocks.removeInvestigationSlackReply).toHaveBeenCalledWith(
      investigationId,
      "investigation-status",
      "1785500001.000200",
    );
  });

  it("shows an issue prompt in the thread containing the button", async () => {
    const response = await signedActionRequest({
      type: "block_actions",
      team: { id: "T123" },
      channel: { id: "C123" },
      user: { id: "U123" },
      response_url: "https://hooks.slack.com/actions/T123/B123/response-token",
      message: {
        thread_ts: "1785500000.000100",
      },
      actions: [
        {
          action_id: "copy_issue_prompt",
          value: "07070707-0707-4707-8707-070707070707",
        },
      ],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.postSlackEphemeralMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "xoxb-test",
        channelId: "C123",
        threadTimestamp: "1785500000.000100",
        userId: "U123",
      }),
    );
  });

  it("shows an issue prompt in the channel for a top-level button", async () => {
    const response = await signedActionRequest({
      type: "block_actions",
      team: { id: "T123" },
      channel: { id: "C123" },
      user: { id: "U123" },
      response_url: "https://hooks.slack.com/actions/T123/B123/response-token",
      message: {},
      actions: [
        {
          action_id: "copy_issue_prompt",
          value: "07070707-0707-4707-8707-070707070707",
        },
      ],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.postSlackEphemeralMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "xoxb-test",
        channelId: "C123",
        threadTimestamp: undefined,
        userId: "U123",
      }),
    );
  });

  it("copies the prompt from the remediation card that was selected", async () => {
    const issueId = "07070707-0707-4707-8707-070707070707";
    const selectedRemediationId = "29292929-2929-4929-8929-292929292929";
    mocks.getIssueForSlackAction.mockResolvedValue({
      id: issueId,
      title: "Plant API returns HTTP 500",
      description: "The plants endpoint is failing.",
      severity: "SEV-2",
      remediation: "Update the palette.",
      remediations: [
        {
          id: "28282828-2828-4828-8828-282828282828",
          type: "external_action",
          title: "Use silver",
          description: "Update production to silver.",
          agentPrompt: "Set petals to silver.",
        },
        {
          id: selectedRemediationId,
          type: "external_action",
          title: "Use bronze",
          description: "Update production to bronze.",
          agentPrompt: "Set petals to bronze.",
        },
      ],
      evidence: [],
      organizationId: "03030303-0303-4303-8303-030303030303",
      encryptedCredentials: "encrypted-slack-token",
    });

    const response = await signedActionRequest({
      type: "block_actions",
      team: { id: "T123" },
      channel: { id: "C123" },
      user: { id: "U123" },
      response_url: "https://hooks.slack.com/actions/T123/B123/response-token",
      message: {},
      actions: [
        {
          action_id: "copy_issue_prompt",
          value: JSON.stringify({
            issueId,
            remediationId: selectedRemediationId,
          }),
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(mocks.postSlackEphemeralMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("bronze") }),
        ]),
      }),
    );
    expect(mocks.postSlackEphemeralMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("silver") }),
        ]),
      }),
    );
  });
});
