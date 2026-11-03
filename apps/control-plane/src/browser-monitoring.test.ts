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

const starterMocks = vi.hoisted(() => ({ startBrowserTelemetry: vi.fn().mockReturnValue(true) }));
vi.mock("./browser-telemetry", () => starterMocks);

import {
  initializeBrowserMonitoring,
  initializeBrowserTelemetry,
  setBrowserMonitoringIdentity,
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
      dsn: "https://public@example.invalid/1",
      environment: "production",
      integrations: [],
      release: "abc123",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
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

  it("starts browser telemetry before the app renders when an ingest endpoint and key are set", () => {
    vi.stubGlobal("window", { location: { origin: "https://superlog.sh" } });
    starterMocks.startBrowserTelemetry.mockClear();

    expect(initializeBrowserTelemetry({})).toBe(false);
    expect(initializeBrowserTelemetry({ ingestEndpoint: "https://superlog.sh/api/ingest" })).toBe(false);
    expect(initializeBrowserTelemetry({ ingestKey: " " })).toBe(false);
    expect(starterMocks.startBrowserTelemetry).not.toHaveBeenCalled();

    expect(
      initializeBrowserTelemetry({
        environment: " production ",
        ingestEndpoint: " https://superlog.sh/api/ingest ",
        ingestKey: "sl_ingest_key",
        release: "web-1",
        tracesSampleRate: "0.5",
      }),
    ).toBe(true);
    expect(starterMocks.startBrowserTelemetry).toHaveBeenCalledWith({
      endpoint: "https://superlog.sh/api/ingest",
      environment: "production",
      ingestKey: "sl_ingest_key",
      origin: "https://superlog.sh",
      release: "web-1",
      sampleRate: 0.5,
    });

    initializeBrowserTelemetry({ ingestEndpoint: "https://superlog.sh/api/ingest", ingestKey: "sl_ingest_key" });
    expect(starterMocks.startBrowserTelemetry).toHaveBeenLastCalledWith(expect.objectContaining({ sampleRate: 0 }));
    vi.unstubAllGlobals();
  });

  it("keeps the app rendering when the telemetry SDK fails to start", () => {
    vi.stubGlobal("window", { location: { origin: "https://superlog.sh" } });
    starterMocks.startBrowserTelemetry.mockImplementationOnce(() => {
      throw new Error("localStorage is unavailable");
    });

    expect(
      initializeBrowserTelemetry({ ingestEndpoint: "https://superlog.sh/api/ingest", ingestKey: "sl_ingest_key" }),
    ).toBe(false);
    vi.unstubAllGlobals();
  });
});
