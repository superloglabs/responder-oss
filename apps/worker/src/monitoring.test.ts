import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  addEventProcessor: vi.fn(),
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
  addEventProcessor: sentryMocks.addEventProcessor,
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
    sentryMocks.addEventProcessor.mockClear();
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

  it("configures secret redaction when Sentry is already initialized", async () => {
    sentryMocks.isInitialized.mockReturnValue(true);
    const monitoring = await import("./monitoring.js");
    const environment = {
      DAYTONA_API_KEY: "daytona-secret",
      SENTRY_DSN: "https://public@example.invalid/1",
    };

    expect(monitoring.initializeErrorMonitoring(environment)).toBe(true);
    expect(
      monitoring.initializeErrorMonitoring({
        ...environment,
        DAYTONA_API_KEY: "rotated-daytona-secret",
      }),
    ).toBe(true);

    expect(sentryMocks.init).not.toHaveBeenCalled();
    expect(sentryMocks.addEventProcessor).toHaveBeenCalledOnce();
    const processor = sentryMocks.addEventProcessor.mock.calls[0]?.[0] as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(
      processor({ message: "request failed for rotated-daytona-secret" }),
    ).toEqual({ message: "request failed for [redacted]" });
  });

  it("reports the original exception and redacts its serialized event", async () => {
    const monitoring = await import("./monitoring.js");
    const environment = {
      DAYTONA_API_KEY: "daytona-secret",
      NODE_ENV: "production",
      SENTRY_DSN: "https://public@example.invalid/1",
      SENTRY_RELEASE: "abc123",
    };

    const originalError = new TypeError("request failed for daytona-secret");
    originalError.stack =
      "TypeError: request failed for daytona-secret\n" +
      "    at runInvestigation (/app/apps/worker/src/investigate.ts:10:2)";

    expect(monitoring.initializeErrorMonitoring(environment)).toBe(true);
    await monitoring.reportWorkerException(
      originalError,
      {
        investigationId: "investigation-1",
        operation: "investigation",
        organizationId: "organization-1",
      },
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
    const eventProcessor = sentryMocks.addEventProcessor.mock.calls[0]?.[0] as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>;
    const serializedEvent = eventProcessor({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  context_line: "request failed for daytona-secret",
                  filename: "/app/apps/worker/src/investigate.ts",
                },
              ],
            },
            type: "TypeError",
            value: "request failed for daytona-secret",
          },
        ],
      },
      extra: { diagnostic: "request failed for daytona-secret" },
    });

    expect(serializedEvent).toEqual(
      expect.objectContaining({
        exception: {
          values: [
            expect.objectContaining({
              stacktrace: {
                frames: [
                  expect.objectContaining({
                    context_line: "request failed for [redacted]",
                  }),
                ],
              },
              type: "TypeError",
              value: "request failed for [redacted]",
            }),
          ],
        },
        extra: { diagnostic: "request failed for [redacted]" },
      }),
    );
    expect(sentryMocks.scope.setContext).toHaveBeenCalledWith(
      "responder",
      expect.objectContaining({ investigationId: "investigation-1" }),
    );
    expect(sentryMocks.captureException).toHaveBeenCalledWith(originalError);
    expect(sentryMocks.flush).not.toHaveBeenCalled();

    await expect(monitoring.flushWorkerMonitoring()).resolves.toBe(true);
    expect(sentryMocks.flush).toHaveBeenCalledWith(2_000);
  });

  it("attaches safe Slack diagnostics to delivery failures", async () => {
    const monitoring = await import("./monitoring.js");
    const { SlackApiError } = await import(
      "@responder/core/integrations/slack"
    );
    monitoring.initializeErrorMonitoring({
      SENTRY_DSN: "https://public@example.invalid/1",
    });
    const error = new AggregateError(
      [
        new SlackApiError("chat.update", "invalid_blocks", [
          "must be more than 0 characters: /0/tasks/1/output",
        ]),
      ],
      "Slack investigation delivery incomplete",
    );

    await monitoring.reportWorkerException(error, {
      investigationId: "investigation-1",
      operation: "slack_delivery",
      organizationId: "organization-1",
    });

    expect(sentryMocks.scope.setTag).toHaveBeenCalledWith(
      "responder.operation",
      "slack_delivery",
    );
    expect(sentryMocks.scope.setContext).toHaveBeenCalledWith("slack", {
      causes: ["Slack chat.update failed (invalid_blocks)"],
      error: "Slack investigation delivery incomplete",
      slackErrors: [
        {
          code: "invalid_blocks",
          diagnostics: [
            "must be more than 0 characters: /0/tasks/1/output",
          ],
          method: "chat.update",
        },
      ],
    });
    expect(sentryMocks.captureException).toHaveBeenCalledWith(error);
  });
});
