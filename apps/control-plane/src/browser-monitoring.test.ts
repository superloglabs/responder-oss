import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  browserTracingIntegration: vi.fn().mockReturnValue("browser-tracing"),
  init: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(false),
  setTag: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock("@sentry/react", () => sentryMocks);

import {
  initializeBrowserMonitoring,
  setBrowserMonitoringIdentity,
} from "./browser-monitoring";

describe("browser error monitoring", () => {
  beforeEach(() => {
    sentryMocks.browserTracingIntegration.mockClear();
    sentryMocks.init.mockClear();
    sentryMocks.isInitialized.mockReset().mockReturnValue(false);
    sentryMocks.setTag.mockClear();
    sentryMocks.setUser.mockClear();
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

  it("drops events with no frame from our scripts before sending", () => {
    initializeBrowserMonitoring({
      appOrigin: "https://superlog.sh",
      dsn: "https://public@example.invalid/1",
    });
    const { beforeSend } = sentryMocks.init.mock.calls[0]![0];
    const event = (filename: string) => ({
      exception: { values: [{ stacktrace: { frames: [{ filename }] } }] },
    });

    expect(beforeSend(event("<anonymous>"))).toBeNull();
    const ours = event("https://superlog.sh/assets/index-LSAnZpwu.js");
    expect(beforeSend(ours)).toBe(ours);
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
});
