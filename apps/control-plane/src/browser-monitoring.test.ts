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
  ignoredBrowserErrors,
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
      ignoreErrors: ignoredBrowserErrors,
      integrations: [],
      release: "abc123",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
  });

  it("ignores PostHog's own request timeouts but not other aborts", () => {
    const ignored = (message: string) =>
      ignoredBrowserErrors.some((pattern) => pattern.test(message));

    expect(ignored("PostHog request timed out after 3000ms")).toBe(true);
    expect(ignored("AbortError: PostHog request timed out after 10000ms")).toBe(true);
    expect(ignored("signal is aborted without reason")).toBe(false);
    expect(ignored("Request timed out after 3000ms")).toBe(false);
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
