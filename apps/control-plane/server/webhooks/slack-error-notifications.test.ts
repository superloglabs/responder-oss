import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackWebhookRoutes } from "./slack.js";

const mocks = vi.hoisted(() => ({ find: vi.fn(), setStatus: vi.fn(), hasCapability: vi.fn() }));
vi.mock("@responder/core/db/error-notifications", () => ({ getErrorNotificationForSlackAction: mocks.find }));
vi.mock("@responder/core/db/error-issues", () => ({ setErrorIssueStatus: mocks.setStatus }));
vi.mock("@responder/core/db/organization-capabilities", () => ({ organizationHasCapability: mocks.hasCapability }));
const deliveryId = "21212121-2121-4121-8121-212121212121";
const responseUrl = "https://hooks.slack.com/actions/T123/B123/token";
async function press(actionId = "error_notification_resolve", options: { value?: string; signature?: string; responseUrl?: string } = {}) {
  const body = new URLSearchParams({ payload: JSON.stringify({
    type: "block_actions", team: { id: "T123" }, channel: { id: "C123" }, user: { id: "U123" },
    response_url: options.responseUrl ?? responseUrl,
    actions: [{ action_id: actionId, value: options.value ?? deliveryId }],
  }) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", "test-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const response = await slackWebhookRoutes.request("/actions", { method: "POST", body, headers: {
    "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": options.signature ?? signature,
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
}
describe("error notification Slack actions", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "test-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    mocks.find.mockResolvedValue({ organizationId: "organization", issueId: "issue" });
    mocks.hasCapability.mockResolvedValue(true);
    mocks.setStatus.mockResolvedValue({ id: "issue" });
  });
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it.each([["resolve", "resolved"], ["silence", "silenced"]])("handles %s and privately confirms the result", async (action, status) => {
    expect((await press(`error_notification_${action}`)).status).toBe(200);
    expect(mocks.find).toHaveBeenCalledWith({ deliveryId, teamId: "T123", channelId: "C123" });
    expect(mocks.setStatus).toHaveBeenCalledWith("organization", "issue", status, {
      actor: { agent: null, client: "Slack", slackUserId: "U123", user: { id: "U123", name: "A Slack user" } },
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(responseUrl);
    expect(JSON.parse(init!.body as string)).toMatchObject({ response_type: "ephemeral", replace_original: false, text: expect.stringContaining(`Error ${status}.`) });
  });
  it("rejects invalid signatures before looking up an issue", async () => {
    expect((await press(undefined, { signature: "v0=invalid" })).status).toBe(401);
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
  it("rejects response URLs outside Slack", async () => {
    expect((await press(undefined, { responseUrl: "https://example.com/actions" })).status).toBe(400);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
  it("does not mutate for a different team/channel or disconnected account", async () => {
    mocks.find.mockResolvedValue(null);
    await press();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
  it("does not mutate when telemetry is unavailable", async () => {
    mocks.hasCapability.mockResolvedValue(false);
    await press();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
  it("rejects malformed delivery IDs", async () => {
    await press(undefined, { value: "not-a-uuid" });
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
  it("reports failed writes without claiming success", async () => {
    mocks.setStatus.mockRejectedValue(new Error("database unavailable"));
    expect((await press()).status).toBe(200);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.text).toContain("Could not update the error");
  });
  it("acknowledges the Conductor link without changing status", async () => {
    expect((await press("conductor_fix")).status).toBe(200);
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
});
