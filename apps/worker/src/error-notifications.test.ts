import { describe, expect, it, vi } from "vitest";
import { deliverErrorNotification, errorNotificationMessage } from "./error-notifications.js";
import { errorNotificationRetryAt } from "@responder/core/db/error-notifications";
import { defaultErrorNotificationSettings } from "@responder/core/telemetry/error-notifications";

type Delivery = Parameters<typeof deliverErrorNotification>[0];
const delivery: Delivery = {
  id: "delivery", organizationId: "workspace", issueId: "issue", eventKey: "new", targetKey: "email:user",
  target: { kind: "email", userId: "user" }, snapshot: { title: "TypeError: <script>alert(1)</script>", service: "api", exceptionType: "TypeError", seenAt: "2026-10-28T12:00:00Z", transition: "new" },
  status: "pending", attempts: 0, createdAt: new Date(), nextAttemptAt: new Date(), sentAt: null,
};
function dependencies() {
  return {
    email: vi.fn<(message: import("@responder/core/email").EmailMessage) => Promise<boolean>>().mockResolvedValue(true), post: vi.fn(async () => []),
    members: vi.fn(async () => [{ id: "user", name: "Ash", email: "ash@example.com" }]),
    channels: vi.fn(async () => [{ integrationAccountId: "account", channelId: "C123", name: "errors", accountName: "Team", private: false }]),
    settings: vi.fn(async () => ({ ...defaultErrorNotificationSettings, enabled: true, targets: [delivery.target] })),
    paused: vi.fn(async () => new Set<string>()), hasCapability: vi.fn(async () => true), origin: () => "https://example.com",
  };
}
describe("error notification delivery", () => {
  it("sends email with a stable retry key and escaped error text", async () => {
    const deps = dependencies();
    await deliverErrorNotification(delivery, deps);
    await deliverErrorNotification(delivery, deps);
    expect(deps.email).toHaveBeenCalledTimes(2);
    expect(deps.email).toHaveBeenLastCalledWith(expect.objectContaining({ to: "ash@example.com", idempotencyKey: "error-notice/delivery" }));
    expect(deps.email.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ html: expect.stringContaining("&lt;script&gt;") }));
  });
  it("does not deliver to a removed or unverified member", async () => {
    const deps = dependencies(); deps.members.mockResolvedValue([]);
    expect(await deliverErrorNotification(delivery, deps)).toBe(false);
    expect(deps.email).not.toHaveBeenCalled();
  });
  it("honors pauses, disabled settings, removed destinations, and service filters", async () => {
    const deps = dependencies();
    deps.paused.mockResolvedValue(new Set(["workspace"]));
    expect(await deliverErrorNotification(delivery, deps)).toBe(false);
    deps.paused.mockResolvedValue(new Set());
    deps.settings.mockResolvedValue({ ...defaultErrorNotificationSettings, targets: [delivery.target] });
    expect(await deliverErrorNotification(delivery, deps)).toBe(false);
    deps.settings.mockResolvedValue({ ...defaultErrorNotificationSettings, enabled: true, targets: [] });
    expect(await deliverErrorNotification(delivery, deps)).toBe(false);
    deps.settings.mockResolvedValue({ ...defaultErrorNotificationSettings, enabled: true, services: ["worker"], targets: [delivery.target] });
    expect(await deliverErrorNotification(delivery, deps)).toBe(false);
    expect(deps.email).not.toHaveBeenCalled();
  });
  it("treats unconfigured email as a retryable failure", async () => {
    const deps = dependencies(); deps.email.mockResolvedValue(false);
    await expect(deliverErrorNotification(delivery, deps)).rejects.toThrow("Email is not configured");
  });
  it("uses the same Slack identity on retries without email", async () => {
    const deps: NonNullable<Parameters<typeof deliverErrorNotification>[1]> = dependencies();
    const slack: Delivery = { ...delivery, targetKey: "slack:account:C123", target: { kind: "slack", integrationAccountId: "account", channelId: "C123" } };
    vi.mocked(deps.settings).mockResolvedValue({ ...defaultErrorNotificationSettings, enabled: true, targets: [slack.target] });
    vi.mocked(deps.post).mockResolvedValue([{ notification: { kind: "slack", integrationAccountId: "account", channelId: "C123" }, timestamp: "123.456" }]);
    expect(await deliverErrorNotification(slack, deps)).toBe(true);
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "workspace", seed: "error-notice/delivery", unfurlLinks: false }));
    expect(deps.email).not.toHaveBeenCalled();
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
