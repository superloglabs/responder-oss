import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  init: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(false),
  scope: {
    setContext: vi.fn(),
    setTag: vi.fn(),
  },
  withScope: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: sentryMocks.captureException,
  flush: sentryMocks.flush,
  init: sentryMocks.init,
  isInitialized: sentryMocks.isInitialized,
  withScope: sentryMocks.withScope.mockImplementation(
    (callback: (scope: typeof sentryMocks.scope) => void) =>
      callback(sentryMocks.scope),
  ),
}));

describe("worker error monitoring", () => {
  beforeEach(() => {
    vi.resetModules();
    sentryMocks.captureException.mockClear();
    sentryMocks.flush.mockClear();
    sentryMocks.init.mockClear();
    sentryMocks.isInitialized.mockReset().mockReturnValue(false);
    sentryMocks.scope.setContext.mockClear();
    sentryMocks.scope.setTag.mockClear();
    sentryMocks.withScope.mockClear();
  });

  it("stays disabled when no DSN is configured", async () => {
    const monitoring = await import("./monitoring.js");

    expect(monitoring.initializeErrorMonitoring({})).toBe(false);
    await monitoring.reportWorkerException(new Error("failed"), {
      operation: "worker",
    });

    expect(sentryMocks.init).not.toHaveBeenCalled();
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });

  it("reports a redacted exception without flushing the error path", async () => {
    const monitoring = await import("./monitoring.js");
    const environment = {
      DAYTONA_API_KEY: "daytona-secret",
      NODE_ENV: "production",
      SENTRY_DSN: "https://public@example.invalid/1",
      SENTRY_RELEASE: "abc123",
    };

    expect(monitoring.initializeErrorMonitoring(environment)).toBe(true);
    await monitoring.reportWorkerException(
      new Error("request failed for daytona-secret"),
      {
        investigationId: "investigation-1",
        operation: "investigation",
        organizationId: "organization-1",
      },
      environment,
    );

    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultIntegrations: false,
        dsn: environment.SENTRY_DSN,
        environment: "production",
        release: "abc123",
        sendDefaultPii: false,
      }),
    );
    expect(sentryMocks.scope.setContext).toHaveBeenCalledWith(
      "responder",
      expect.objectContaining({ investigationId: "investigation-1" }),
    );
    expect(sentryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "request failed for [redacted]",
      }),
    );
    expect(sentryMocks.flush).not.toHaveBeenCalled();

    await expect(monitoring.flushWorkerMonitoring()).resolves.toBe(true);
    expect(sentryMocks.flush).toHaveBeenCalledWith(2_000);
  });
});
