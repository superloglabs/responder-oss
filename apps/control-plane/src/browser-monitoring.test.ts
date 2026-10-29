import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  browserTracingIntegration: vi.fn().mockReturnValue("browser-tracing"),
  init: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(false),
  setTag: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock("@sentry/react", () => sentryMocks);

const telemetryMocks = vi.hoisted(() => ({ setAttributes: vi.fn(), setUser: vi.fn() }));
vi.mock("@superlog/browser/api", () => telemetryMocks);

import {
  initializeBrowserMonitoring,
  isCancelledRequest,
  setBrowserMonitoringIdentity,
  startSignedInBrowserTelemetry,
} from "./browser-monitoring";

describe("browser error monitoring", () => {
  beforeEach(() => {
    sentryMocks.browserTracingIntegration.mockClear();
    sentryMocks.init.mockClear();
    sentryMocks.isInitialized.mockReset().mockReturnValue(false);
    sentryMocks.setTag.mockClear();
    sentryMocks.setUser.mockClear();
    telemetryMocks.setAttributes.mockClear();
    telemetryMocks.setUser.mockClear();
  });

  it("does not initialize without a DSN", () => {
    expect(initializeBrowserMonitoring({})).toBe(false);
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it("initializes without tracing by default", () => {
    expect(
      initializeBrowserMonitoring({
        dsn: "https://public@example.invalid/1",
        environment: "production",
        release: "abc123",
      }),
    ).toBe(true);

    expect(sentryMocks.init).toHaveBeenCalledWith({
      beforeSend: expect.any(Function),
      dsn: "https://public@example.invalid/1",
      environment: "production",
      integrations: [],
      release: "abc123",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
  });

  it("drops cancelled requests but keeps timeouts and other errors", () => {
    initializeBrowserMonitoring({ dsn: "https://public@example.invalid/1" });
    const { beforeSend } = sentryMocks.init.mock.calls[0][0];
    const event = (type: string) => ({
      exception: { values: [{ type, value: "details" }] },
    });

    expect(isCancelledRequest(event("AbortError") as never)).toBe(true);
    expect(beforeSend(event("AbortError"))).toBeNull();
    expect(beforeSend(event("TimeoutError"))).toEqual(event("TimeoutError"));
    expect(beforeSend(event("TypeError"))).toEqual(event("TypeError"));
    expect(beforeSend({ message: "plain" })).toEqual({ message: "plain" });
  });

  it("sets names and clears the old name while a new organization loads", () => {
    setBrowserMonitoringIdentity("user-1", "organization-1", "Ada", "Acme");
    expect(sentryMocks.setUser).toHaveBeenLastCalledWith({ id: "user-1", username: "Ada" });
    expect(sentryMocks.setTag).toHaveBeenLastCalledWith("organization_name", "Acme");
    setBrowserMonitoringIdentity("user-1", "organization-2", "Ada");
    expect(sentryMocks.setTag).toHaveBeenLastCalledWith("organization_name", "");
  });

  it("clears identity fields after sign out", () => {
    setBrowserMonitoringIdentity("user-1", "organization-1", "Ada", "Acme");
    setBrowserMonitoringIdentity();

    expect(sentryMocks.setUser).toHaveBeenLastCalledWith(null);
    expect(sentryMocks.setTag).toHaveBeenCalledWith("organization_id", "");
    expect(sentryMocks.setTag).toHaveBeenLastCalledWith("organization_name", "");
  });

  it("sends the user and organization to browser telemetry", () => {
    setBrowserMonitoringIdentity("user-1", "organization-1", "Ada", "Acme");
    expect(telemetryMocks.setUser).toHaveBeenLastCalledWith({ id: "user-1", name: "Ada" });
    expect(telemetryMocks.setAttributes).toHaveBeenLastCalledWith({ "organization.id": "organization-1", "organization.name": "Acme" });

    setBrowserMonitoringIdentity();
    expect(telemetryMocks.setUser).toHaveBeenLastCalledWith(null);
    expect(telemetryMocks.setAttributes).toHaveBeenLastCalledWith({ "organization.id": undefined, "organization.name": undefined });
  });

  it("starts browser traces after sign-in only when a sample rate is set", async () => {
    vi.stubGlobal("window", { location: { origin: "https://superlog.sh" } });
    const startBrowserTelemetry = vi.fn().mockReturnValue(true);
    const load = vi.fn().mockResolvedValue({ startBrowserTelemetry });

    await expect(startSignedInBrowserTelemetry({}, load)).resolves.toBe(false);
    await expect(startSignedInBrowserTelemetry({ otelTracesSampleRate: "0" }, load)).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();

    await expect(
      startSignedInBrowserTelemetry(
        { environment: " production ", otelTracesSampleRate: "0.5", release: "web-1" },
        load,
      ),
    ).resolves.toBe(true);
    expect(startBrowserTelemetry).toHaveBeenCalledWith({
      environment: "production",
      origin: "https://superlog.sh",
      release: "web-1",
      sampleRate: 0.5,
    });

    await expect(
      startSignedInBrowserTelemetry(
        { otelTracesSampleRate: "1" },
        vi.fn().mockRejectedValue(new Error("chunk failed")),
      ),
    ).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});
