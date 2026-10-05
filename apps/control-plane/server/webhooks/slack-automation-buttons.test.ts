import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackWebhookRoutes } from "./slack.js";

const mocks = vi.hoisted(() => ({
  getButtons: vi.fn(),
  queueReply: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  findAutomationsForSlackEvent: vi.fn(),
  findSlackThreadAutomationRun: vi.fn(),
  getAutomationRunSlackButtons: mocks.getButtons,
  recordSlackMessageAuthor: vi.fn(),
}));
vi.mock("../automations/queue.js", () => ({
  queueAutomationRun: vi.fn(),
  queueAutomationRunReply: mocks.queueReply,
}));

const signingSecret = "slack-signing-secret";
const runId = "21212121-2121-4121-8121-212121212121";
const integrationAccountId = "41414141-4141-4141-8141-414141414141";
const responseUrl = "https://hooks.slack.com/actions/T123/B123/response-token";
const messageBlocks = [
  { block_id: "text", text: "Checkout is failing.", type: "markdown" },
  { block_id: "automation_run_buttons", elements: [], type: "actions" },
];

// Sends a press and lets the work after Slack's acknowledgement finish.
async function press(overrides: Record<string, unknown> = {}) {
  const payload = {
    actions: [{ action_id: "automation_run_button:0", block_id: "automation_run_buttons", value: runId }],
    channel: { id: "C123" },
    message: { blocks: messageBlocks, text: "Checkout is failing.", ts: "1790000001.000100" },
    response_url: responseUrl,
    team: { id: "T123" },
    type: "block_actions",
    user: { id: "U123", name: "ada" },
    ...overrides,
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const response = await slackWebhookRoutes.request("/actions", {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    method: "POST",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
}

function responses(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url, init]) => ({ body: JSON.parse((init as RequestInit).body as string), url }));
}

describe("automation buttons in Slack", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", signingSecret);
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.getButtons.mockResolvedValue({ automationEnabled: true, buttons: ["Create PR", "Ignore"], integrationAccountId });
    mocks.queueReply.mockResolvedValue("queued");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("stores the press before acknowledging Slack and updates the message afterwards", async () => {
    let queued = false;
    mocks.queueReply.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      queued = true;
      return "queued";
    });
    // Slack's response URL never answers.
    fetchMock.mockReturnValue(new Promise(() => undefined));

    const response = await press();

    expect(response.status).toBe(200);
    expect(queued).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("tells the person when the press cannot be looked up", async () => {
    mocks.getButtons.mockRejectedValue(new Error("database unavailable"));

    const response = await press();

    expect(response.status).toBe(200);
    expect(mocks.queueReply).not.toHaveBeenCalled();
    expect(responses(fetchMock)).toEqual([{
      body: { replace_original: false, response_type: "ephemeral", text: "Responder could not continue the run. Continue it from the run page in Responder." },
      url: responseUrl,
    }]);
  });

  it("continues the run that posted the message and replaces its buttons", async () => {
    const response = await press();

    expect(response.status).toBe(200);
    expect(mocks.getButtons).toHaveBeenCalledWith({
      channelId: "C123",
      messageTimestamp: "1790000001.000100",
      runId,
      teamId: "T123",
    });
    expect(mocks.queueReply).toHaveBeenCalledWith({
      message: {
        authorId: "U123",
        authorName: "ada",
        externalEventId: "slack_button:C123:1790000001.000100",
        slackButton: {
          channelId: "C123",
          integrationAccountId,
          label: "Create PR",
          messageTimestamp: "1790000001.000100",
          threadTimestamp: "1790000001.000100",
        },
        source: "slack",
        text: "Pressed \"Create PR\"",
      },
      runId,
    });
    expect(responses(fetchMock)).toEqual([{
      body: {
        blocks: [
          messageBlocks[0],
          {
            elements: [
              { text: "<@U123> pressed", type: "mrkdwn" },
              { emoji: true, text: "Create PR", type: "plain_text" },
            ],
            type: "context",
          },
        ],
        replace_original: true,
        text: "Checkout is failing.",
      },
      url: responseUrl,
    }]);
  });

  it("answers in the thread of a message posted as a reply", async () => {
    await press({
      actions: [{ action_id: "automation_run_button:1", value: runId }],
      message: { blocks: messageBlocks, ts: "1790000003.000100", thread_ts: "1790000001.000100" },
    });

    expect(mocks.queueReply).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        slackButton: expect.objectContaining({
          label: "Ignore",
          messageTimestamp: "1790000003.000100",
          threadTimestamp: "1790000001.000100",
        }),
      }),
    }));
  });

  it("tells the person when the message has no such button or the run is not found", async () => {
    mocks.getButtons.mockResolvedValue(null);
    await press();
    mocks.getButtons.mockResolvedValue({ automationEnabled: true, buttons: ["Create PR"], integrationAccountId });
    await press({ actions: [{ action_id: "automation_run_button:3", value: runId }] });

    expect(mocks.queueReply).not.toHaveBeenCalled();
    expect(responses(fetchMock).map((call) => call.body)).toEqual([
      { replace_original: false, response_type: "ephemeral", text: "This button is no longer available." },
      { replace_original: false, response_type: "ephemeral", text: "This button is no longer available." },
    ]);
  });

  it("ignores a button whose value is not a run", async () => {
    await press({ actions: [{ action_id: "automation_run_button:0", value: "not-a-run" }] });

    expect(mocks.getButtons).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not continue a run whose automation is off", async () => {
    mocks.getButtons.mockResolvedValue({ automationEnabled: false, buttons: ["Create PR"], integrationAccountId });

    await press();

    expect(mocks.queueReply).not.toHaveBeenCalled();
    expect(responses(fetchMock)[0]?.body).toMatchObject({ response_type: "ephemeral", text: expect.stringContaining("turned off") });
  });

  it("counts only the first press on a message", async () => {
    mocks.queueReply.mockResolvedValue("duplicate");

    await press();

    expect(responses(fetchMock)).toEqual([{
      body: { replace_original: false, response_type: "ephemeral", text: "A button on this message was already pressed." },
      url: responseUrl,
    }]);
  });

  it("keeps the buttons when the run cannot be queued", async () => {
    mocks.queueReply.mockRejectedValue(new Error("Automation worker is unavailable"));

    await press();

    expect(responses(fetchMock)).toEqual([{
      body: { replace_original: false, response_type: "ephemeral", text: "Responder could not continue the run. Continue it from the run page in Responder." },
      url: responseUrl,
    }]);
  });
});
