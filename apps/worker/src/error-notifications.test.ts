import { describe, expect, it, vi } from "vitest";
import { deliverErrorNotification, errorNotificationMessage } from "./error-notifications.js";
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
    expect(vi.mocked(deps.post).mock.calls[0]?.[0].markdown).toContain("&lt;script&gt;");
    vi.mocked(deps.post).mockResolvedValue([]);
    await expect(deliverErrorNotification(slack, deps)).rejects.toThrow("Slack notification failed");
  });
  it("distinguishes regressions from first occurrences", () => {
    expect(errorNotificationMessage({ ...delivery.snapshot, transition: "regressed" }, "https://example.com").text).toContain("was resolved and has occurred again");
    expect(errorNotificationMessage(delivery.snapshot, "https://example.com").subject).toMatch(/^New error:/u);
  });
  it("backs off retries up to one hour", () => {
    const now = new Date(0);
    expect(errorNotificationRetryAt(1, now).getTime()).toBe(60_000);
    expect(errorNotificationRetryAt(2, now).getTime()).toBe(120_000);
    expect(errorNotificationRetryAt(10, now).getTime()).toBe(3_600_000);
  });
});
