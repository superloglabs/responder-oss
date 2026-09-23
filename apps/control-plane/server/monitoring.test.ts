import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  getOrganizationName: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  init: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(false),
}));

vi.mock("@sentry/hono/node", () => sentryMocks);

vi.mock("@responder/core/db/organizations", () => ({
  getOrganizationName: sentryMocks.getOrganizationName,
}));

describe("control-plane error monitoring", () => {
  beforeEach(() => {
    vi.resetModules();
    sentryMocks.getOrganizationName.mockReset().mockResolvedValue("Acme");
    sentryMocks.flush.mockClear();
    sentryMocks.init.mockClear();
    sentryMocks.isInitialized.mockReset().mockReturnValue(false);
  });

  afterEach(() => { vi.useRealTimers(); });

  it("releases the scrubbed error event when the organization lookup stalls", async () => {
    const monitoring = await import("./monitoring.js");
    vi.useFakeTimers();
    sentryMocks.getOrganizationName.mockReturnValue(new Promise(() => {}));
    monitoring.initializeServerMonitoring({ SENTRY_DSN: "https://public@example.invalid/1" });
    const beforeSend = sentryMocks.init.mock.calls[0]![0].beforeSend;
    const completed = vi.fn();
    void beforeSend({
      tags: { organization_id: "org-1" },
      user: { id: "user-1", username: "Ada" },
      request: { cookies: { session: "secret" } },
    }).then(completed);
    await vi.advanceTimersByTimeAsync(249);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledWith({
      tags: { organization_id: "org-1" },
      user: { id: "user-1", username: "Ada" },
      request: {},
    });
  });

  it("enriches the event when a delayed lookup completes inside the time limit", async () => {
    const monitoring = await import("./monitoring.js");
    vi.useFakeTimers();
    sentryMocks.getOrganizationName.mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve("Acme"), 100)),
    );
    monitoring.initializeServerMonitoring({ SENTRY_DSN: "https://public@example.invalid/1" });
    const beforeSend = sentryMocks.init.mock.calls[0]![0].beforeSend;
    const completed = vi.fn();
    void beforeSend({ tags: { organization_id: "org-1" } }).then(completed);
    await vi.advanceTimersByTimeAsync(99);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledWith({
      tags: { organization_id: "org-1", organization_name: "Acme" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays disabled when no DSN is configured", async () => {
    const monitoring = await import("./monitoring.js");

    expect(monitoring.initializeServerMonitoring({})).toBe(false);
    await expect(monitoring.flushServerMonitoring()).resolves.toBe(false);

    expect(sentryMocks.init).not.toHaveBeenCalled();
    expect(sentryMocks.flush).not.toHaveBeenCalled();
  });

  it("initializes once with scrubbed request reporting", async () => {
    const monitoring = await import("./monitoring.js");
    const environment = {
      NODE_ENV: "production",
      SENTRY_DSN: "https://public@example.invalid/1",
      SENTRY_ENVIRONMENT: "production",
      SENTRY_RELEASE: "abc123",
    };

    expect(monitoring.initializeServerMonitoring(environment)).toBe(true);
    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeSend: expect.any(Function),
        dsn: environment.SENTRY_DSN,
        environment: "production",
        release: "abc123",
        sendDefaultPii: false,
        tracesSampleRate: 0,
      }),
    );

    const beforeSend = sentryMocks.init.mock.calls[0]![0].beforeSend;
    const event = await beforeSend({
      tags: { organization_id: "org-1" },
      user: { id: "user-1", username: "Ada" },
      request: { cookies: { session: "secret" }, url: "https://example.com/api?token=secret" },
    });
    expect(event.tags).toEqual({ organization_id: "org-1", organization_name: "Acme" });
    expect(event.user).toEqual({ id: "user-1", username: "Ada" });
    expect(event.request).toEqual({ url: "https://example.com/api" });

    sentryMocks.isInitialized.mockReturnValue(true);
    expect(monitoring.initializeServerMonitoring(environment)).toBe(true);
    await expect(monitoring.flushServerMonitoring()).resolves.toBe(true);

    expect(sentryMocks.init).toHaveBeenCalledTimes(1);
    expect(sentryMocks.flush).toHaveBeenCalledWith(2_000);
  });
});
