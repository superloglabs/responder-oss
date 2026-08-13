import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogMocks = vi.hoisted(() => ({
  captureImmediate: vi.fn(),
  constructor: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      posthogMocks.constructor(...args);
    }

    captureImmediate(input: unknown) {
      return posthogMocks.captureImmediate(input);
    }
  },
}));

describe("product analytics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    posthogMocks.captureImmediate.mockReset().mockResolvedValue(undefined);
    posthogMocks.constructor.mockReset();
  });

  it("is disabled when the project token is absent", async () => {
    const { captureAnalyticsEvent } = await import("./analytics.js");

    await captureAnalyticsEvent({
      distinctId: "user-1",
      event: "agent created",
    });

    expect(posthogMocks.constructor).not.toHaveBeenCalled();
    expect(posthogMocks.captureImmediate).not.toHaveBeenCalled();
  });

  it("captures organization context and event properties immediately", async () => {
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
    vi.stubEnv("POSTHOG_HOST", "https://eu.i.posthog.com");
    const { captureAnalyticsEvent } = await import("./analytics.js");

    await captureAnalyticsEvent({
      distinctId: "user-1",
      event: "integration connected",
      organizationId: "organization-1",
      properties: {
        integration_account_id: "account-1",
        provider: "github",
      },
    });

    expect(posthogMocks.constructor).toHaveBeenCalledWith("phc_test", {
      host: "https://eu.i.posthog.com",
      requestTimeout: 3_000,
    });
    expect(posthogMocks.captureImmediate).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: "integration connected",
      groups: { organization: "organization-1" },
      properties: {
        integration_account_id: "account-1",
        organization_id: "organization-1",
        project: "responder",
        provider: "github",
      },
    });
  });

  it("does not allow callers to override the project tag", async () => {
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
    const { captureAnalyticsEvent } = await import("./analytics.js");

    await captureAnalyticsEvent({
      distinctId: "user-1",
      event: "agent created",
      properties: { project: "another-project" },
    });

    expect(posthogMocks.captureImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: { project: "responder" },
      }),
    );
  });

  it("does not fail the product action when delivery fails", async () => {
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
    posthogMocks.captureImmediate.mockRejectedValue(new Error("offline"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureAnalyticsEvent } = await import("./analytics.js");

    await expect(
      captureAnalyticsEvent({
        distinctId: "organization:organization-1",
        event: "investigation started",
        organizationId: "organization-1",
      }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "Unable to capture investigation started analytics event: offline",
    );

    consoleError.mockRestore();
  });
});
