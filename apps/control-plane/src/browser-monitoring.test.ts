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
      dsn: "https://public@example.invalid/1",
      environment: "production",
      integrations: [],
      release: "abc123",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
  });

  it("clears identity fields after sign out", () => {
    setBrowserMonitoringIdentity("user-1", "organization-1");
    setBrowserMonitoringIdentity();

    expect(sentryMocks.setUser).toHaveBeenLastCalledWith(null);
    expect(sentryMocks.setTag).toHaveBeenLastCalledWith("organization_id", "");
  });
});
