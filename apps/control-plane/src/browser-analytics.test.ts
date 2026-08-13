import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogMocks = vi.hoisted(() => ({
  group: vi.fn(),
  identify: vi.fn(),
  init: vi.fn(),
  capture: vi.fn(),
  register: vi.fn(),
  reset: vi.fn(),
  startSessionRecording: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: {
    capture: posthogMocks.capture,
    group: posthogMocks.group,
    identify: posthogMocks.identify,
    init: posthogMocks.init,
    register: posthogMocks.register,
    reset: posthogMocks.reset,
  },
}));

describe("browser analytics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("window", {});
  });

  it("does not load analytics when the project token is absent", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
    const { captureBrowserPageView, initializeBrowserAnalytics } = await import(
      "./browser-analytics"
    );

    await initializeBrowserAnalytics();
    await captureBrowserPageView("https://responder.example/agents");

    expect(posthogMocks.init).not.toHaveBeenCalled();
    expect(posthogMocks.capture).not.toHaveBeenCalled();
  });

  it("uses configured analytics and starts masked session recording", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://analytics.example.com");
    const { initializeBrowserAnalytics } = await import("./browser-analytics");

    await initializeBrowserAnalytics();
    await initializeBrowserAnalytics();

    expect(posthogMocks.init).toHaveBeenCalledTimes(1);
    expect(posthogMocks.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        api_host: "https://analytics.example.com",
        capture_pageview: false,
        defaults: "2026-05-30",
        disable_session_recording: false,
        person_profiles: "identified_only",
        session_recording: {
          maskAllInputs: true,
        },
      }),
    );
    const config = posthogMocks.init.mock.calls[0]?.[1];
    config.loaded({
      register: posthogMocks.register,
      startSessionRecording: posthogMocks.startSessionRecording,
    });
    expect(posthogMocks.register).toHaveBeenCalledOnce();
    expect(posthogMocks.register).toHaveBeenCalledWith({
      project: "responder",
    });
    expect(posthogMocks.startSessionRecording).toHaveBeenCalledWith(true);
    expect(posthogMocks.register).toHaveBeenCalledBefore(
      posthogMocks.startSessionRecording,
    );
  });

  it("treats analytics initialization failures as optional and retries", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test");
    posthogMocks.init.mockImplementationOnce(() => {
      throw new Error("Analytics module unavailable");
    });
    const { initializeBrowserAnalytics } = await import("./browser-analytics");

    await expect(initializeBrowserAnalytics()).resolves.toBeUndefined();
    await expect(initializeBrowserAnalytics()).resolves.toBeUndefined();

    expect(posthogMocks.init).toHaveBeenCalledTimes(2);
  });

  it("captures each browser URL once", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test");
    const { captureBrowserPageView } = await import("./browser-analytics");

    await captureBrowserPageView("https://responder.example/");
    await captureBrowserPageView("https://responder.example/");
    await captureBrowserPageView("https://responder.example/agents");

    expect(posthogMocks.capture).toHaveBeenCalledTimes(2);
    expect(posthogMocks.capture).toHaveBeenNthCalledWith(1, "$pageview", {
      $current_url: "https://responder.example/",
    });
    expect(posthogMocks.capture).toHaveBeenNthCalledWith(2, "$pageview", {
      $current_url: "https://responder.example/agents",
    });
  });

  it("links authenticated browser activity to the user and organization", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test");
    const { identifyBrowserUser } = await import("./browser-analytics");

    await identifyBrowserUser(
      { id: "user_123", email: "user@example.com", name: "Example User" },
      "org_456",
    );

    expect(posthogMocks.identify).toHaveBeenCalledWith("user_123", {
      email: "user@example.com",
      name: "Example User",
    });
    expect(posthogMocks.group).toHaveBeenCalledWith("organization", "org_456");
  });

  it("clears the browser identity on sign out", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test");
    const { resetBrowserAnalytics } = await import("./browser-analytics");

    await resetBrowserAnalytics();

    expect(posthogMocks.reset).toHaveBeenCalledOnce();
  });
});
