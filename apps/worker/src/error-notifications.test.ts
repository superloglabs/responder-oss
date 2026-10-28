import { describe, expect, it, vi } from "vitest";
import { deliverErrorNotification, errorNotificationBlocks, errorNotificationMessage } from "./error-notifications.js";
import { errorNotificationRetryAt } from "@responder/core/db/error-notifications";
import { defaultErrorNotificationSettings } from "@responder/core/telemetry/error-notifications";

type Delivery = Parameters<typeof deliverErrorNotification>[0];
const delivery: Delivery = {
  id: "delivery", organizationId: "workspace", issueId: "issue", eventKey: "new", targetKey: "slack:account:C123",
  target: { kind: "slack", integrationAccountId: "account", channelId: "C123" }, snapshot: { title: "TypeError: <script>alert(1)</script>", service: "api", exceptionType: "TypeError", seenAt: "2026-10-28T12:00:00Z", transition: "new" },
  status: "pending", attempts: 0, createdAt: new Date(), nextAttemptAt: new Date(), sentAt: null,
};
function dependencies() {
  return {
    post: vi.fn<NonNullable<Parameters<typeof deliverErrorNotification>[1]>["post"]>().mockResolvedValue([{ notification: { kind: "slack", integrationAccountId: "account", channelId: "C123" }, timestamp: "123.456" }]),
    channels: vi.fn(async () => [{ integrationAccountId: "account", channelId: "C123", name: "errors", accountName: "Team", private: false }]),
    settings: vi.fn(async () => ({ ...defaultErrorNotificationSettings, enabled: true, targets: [delivery.target] })),
    paused: vi.fn(async () => new Set<string>()), hasCapability: vi.fn(async () => true), origin: () => "https://example.com",
  };
}
describe("error notification delivery", () => {
  it("does not deliver to an unavailable channel", async () => {
    const deps = dependencies(); deps.channels.mockResolvedValue([]);
    expect(await deliverErrorNotification(delivery, deps)).toBe(false);
    expect(deps.post).not.toHaveBeenCalled();
  });
  it("honors pauses, disabled settings, removed destinations", async () => {
    const deps = dependencies();
    deps.paused.mockResolvedValue(new Set(["workspace"]));
    expect(await deliverErrorNotification(delivery, deps)).toBe(false);
    deps.paused.mockResolvedValue(new Set());
    deps.settings.mockResolvedValue({ ...defaultErrorNotificationSettings, targets: [delivery.target] });
    expect(await deliverErrorNotification(delivery, deps)).toBe(false);
    deps.settings.mockResolvedValue({ ...defaultErrorNotificationSettings, enabled: true, targets: [] });
    expect(await deliverErrorNotification(delivery, deps)).toBe(false);
    expect(deps.post).not.toHaveBeenCalled();
  });
  it("uses the same Slack identity on retries", async () => {
    const deps: NonNullable<Parameters<typeof deliverErrorNotification>[1]> = dependencies();
    const slack: Delivery = { ...delivery, targetKey: "slack:account:C123", target: { kind: "slack", integrationAccountId: "account", channelId: "C123" } };
    vi.mocked(deps.settings).mockResolvedValue({ ...defaultErrorNotificationSettings, enabled: true, targets: [slack.target] });
    vi.mocked(deps.post).mockResolvedValue([{ notification: { kind: "slack", integrationAccountId: "account", channelId: "C123" }, timestamp: "123.456" }]);
    expect(await deliverErrorNotification(slack, deps)).toBe(true);
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "workspace", seed: "error-notice/delivery", unfurlLinks: false }));
    await deliverErrorNotification(slack, deps);
    expect(deps.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.post).mock.calls[0]?.[0].blocks).toEqual(errorNotificationBlocks(slack.snapshot, "https://example.com/errors/issue"));
    vi.mocked(deps.post).mockResolvedValue([]);
    await expect(deliverErrorNotification(slack, deps)).rejects.toThrow("Slack notification failed");
  });
  it("includes resolve, silence and a Conductor handoff for this delivery", async () => {
    const deps = dependencies();
    await deliverErrorNotification(delivery, deps);
    const block = deps.post.mock.calls[0]![0].buttonsBlock;
    expect(block).toMatchObject({ type: "actions", elements: [
      { action_id: "error_notification_resolve", value: delivery.id, text: { text: "Resolve" } },
      { action_id: "error_notification_silence", value: delivery.id, text: { text: "Silence" } },
      { action_id: "conductor_fix", text: { text: "Fix in Conductor" }, url: expect.stringContaining("https://example.com/api/ide/conductor#prompt=") },
    ] });
    const handoff = (block as { elements: Array<{ url?: string }> }).elements[2]!.url!;
    expect(decodeURIComponent(handoff)).toContain("https://example.com/errors/issue");
    expect(decodeURIComponent(handoff)).toContain(delivery.snapshot.title);
  });
  it("distinguishes regressions from first occurrences", () => {
    expect(errorNotificationMessage({ ...delivery.snapshot, transition: "regressed" }, "https://example.com").text).toContain("was resolved and has occurred again");
    expect(errorNotificationMessage(delivery.snapshot, "https://example.com").subject).toMatch(/^New error:/u);
  });
  it("uses literal text for error content and a separate linked title", () => {
    const title = "TypeError: ``` <!channel> *oops* <script>";
    const blocks = errorNotificationBlocks({ ...delivery.snapshot, title }, "https://example.com/errors/issue");
    expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "New error", emoji: true } });
    expect(blocks[1]).toEqual({ type: "rich_text", elements: [
      { type: "rich_text_section", elements: [
        { type: "text", text: "🔴 " },
        { type: "link", url: "https://example.com/errors/issue", text: "TypeError", style: { bold: true } },
      ] },
    ] });
    expect(blocks[2]).toEqual({ type: "rich_text", elements: [
      { type: "rich_text_preformatted", elements: [{ type: "text", text: "``` <!channel> *oops* <script>" }] },
    ] });
    expect(JSON.stringify(blocks)).not.toContain("State:");
    expect(blocks[3]?.elements).toContainEqual(expect.objectContaining({ type: "mrkdwn", text: expect.stringContaining("First seen: <!date^") }));
  });
  it("marks returning errors and tolerates missing metadata", () => {
    const blocks = errorNotificationBlocks({ ...delivery.snapshot, transition: "regressed", service: null, seenAt: "invalid" }, "https://example.com");
    expect(JSON.stringify(blocks)).toContain("🟠 ");
    expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "Error recurrence", emoji: true } });
    expect(blocks[3]?.elements).toEqual([
      { type: "plain_text", text: "Service: unknown", emoji: true },
    ]);
  });
  it("bounds large error content without dropping the issue link", () => {
    const blocks = errorNotificationBlocks({ ...delivery.snapshot, title: "x".repeat(20_000), service: "s".repeat(20_000), exceptionType: "t".repeat(20_000) }, "https://example.com");
    expect(JSON.stringify(blocks).length).toBeLessThan(3000);
    expect(JSON.stringify(blocks)).toContain('"url":"https://example.com"');
    expect(JSON.stringify(blocks)).toContain("…");
  });
  it("backs off retries up to one hour", () => {
    const now = new Date(0);
    expect(errorNotificationRetryAt(1, now).getTime()).toBe(60_000);
    expect(errorNotificationRetryAt(2, now).getTime()).toBe(120_000);
    expect(errorNotificationRetryAt(10, now).getTime()).toBe(3_600_000);
  });
});
