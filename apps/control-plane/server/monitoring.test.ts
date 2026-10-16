import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  getOrganizationName: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  httpIntegration: vi.fn((options: unknown) => ({ name: "Http", options })),
  init: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(false),
  nativeNodeFetchIntegration: vi.fn((options: unknown) => ({ name: "NodeFetch", options })),
  SentryContextManager: vi.fn(),
  validateOpenTelemetrySetup: vi.fn(),
}));
const telemetryMocks = vi.hoisted(() => ({
  flush: vi.fn().mockResolvedValue(undefined),
  startNodeTelemetry: vi.fn(),
}));

vi.mock("@sentry/hono/node", () => sentryMocks);
vi.mock("@responder/core/observability/opentelemetry", async (importOriginal) => ({
  ...await importOriginal<typeof import("@responder/core/observability/opentelemetry")>(),
  startNodeTelemetry: telemetryMocks.startNodeTelemetry,
}));

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
    sentryMocks.validateOpenTelemetrySetup.mockClear();
    telemetryMocks.flush.mockClear();
    telemetryMocks.startNodeTelemetry
      .mockReset()
      .mockReturnValue({ flush: telemetryMocks.flush, shutdown: vi.fn() });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("releases the scrubbed error event when the organization lookup stalls", async () => {
    const monitoring = await import("./monitoring.js");
    // beforeSend imports the lookup on first use; load it before faking timers.
    await import("@responder/core/observability/sentry-identity");
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
    // beforeSend imports the lookup on first use; load it before faking timers.
    await import("@responder/core/observability/sentry-identity");
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
        skipOpenTelemetrySetup: false,
        tracesSampleRate: 0,
      }),
    );
    expect(telemetryMocks.startNodeTelemetry).not.toHaveBeenCalled();

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

  it("exports traces, metrics, and logs over OTLP without a DSN", async () => {
    const client = { name: "client" };
    sentryMocks.init.mockReturnValue(client);
    const monitoring = await import("./monitoring.js");
    const environment = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://superlog.sh/api/ingest",
    };

    expect(monitoring.initializeServerMonitoring(environment)).toBe(true);
    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://otlp@sentry.invalid/1",
        integrations: [
          expect.objectContaining({ name: "Http" }),
          { name: "NodeFetch", options: { spans: true } },
        ],
        skipOpenTelemetrySetup: true,
        tracesSampleRate: 1,
        transport: expect.any(Function),
      }),
    );
    // Nothing is enriched or sent to Sentry without a DSN of its own.
    const beforeSend = sentryMocks.init.mock.calls[0]![0].beforeSend;
    await expect(beforeSend({ tags: { organization_id: "org-1" } })).resolves.toBeNull();
    expect(sentryMocks.getOrganizationName).not.toHaveBeenCalled();
    expect(telemetryMocks.startNodeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        environment,
        sentryClient: client,
        serviceName: "responder-control-plane",
      }),
    );
    expect(sentryMocks.validateOpenTelemetrySetup).toHaveBeenCalled();

    sentryMocks.isInitialized.mockReturnValue(true);
    await monitoring.flushServerMonitoring(500);
    expect(telemetryMocks.flush).toHaveBeenCalledWith(500);
  });

  it("does not trace health checks or telemetry ingest", async () => {
    const { isUntracedRequest } = await import("./monitoring.js");

    expect(isUntracedRequest("/api/health")).toBe(true);
    expect(isUntracedRequest("/api/ingest/v1/traces")).toBe(true);
    expect(isUntracedRequest("/api/telemetry/browser/v1/traces")).toBe(true);
    expect(isUntracedRequest("/api/health?probe=1")).toBe(true);
    expect(isUntracedRequest("/api/healthz")).toBe(false);
    expect(isUntracedRequest("/api/telemetry/logs")).toBe(false);
  });
});
