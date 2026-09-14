import { describe, expect, it } from "vitest";
import {
  integrationActionUrl,
  sentryConnectionUrl,
} from "./settings-presentation";

describe("settings integration actions", () => {
  it("opens GitHub installation configuration for a connected account", () => {
    expect(
      integrationActionUrl({
        configurationUrl: "/api/integrations/github/start?mode=install",
        connectUrl: "/api/integrations/github/start",
        state: "connected",
      }),
    ).toBe("/api/integrations/github/start?mode=install");
  });

  it("uses the first-time connection URL for an available integration", () => {
    expect(
      integrationActionUrl({
        configurationUrl: "/api/integrations/github/start?mode=install",
        connectUrl: "/api/integrations/github/start?mode=install",
        state: "available",
      }),
    ).toBe("/api/integrations/github/start?mode=install");
  });

  it("targets one Sentry account for reconnect", () => {
    expect(
      sentryConnectionUrl("/api/integrations/sentry/start", {
        accountId: "30000000-0000-4000-8000-000000000000",
      }),
    ).toBe(
      "/api/integrations/sentry/start?returnTo=%2Fsettings" +
        "&integrationAccountId=30000000-0000-4000-8000-000000000000",
    );
  });

  it("starts a fresh Sentry installation without retrying another account", () => {
    expect(
      sentryConnectionUrl("/api/integrations/sentry/start", {
        freshInstall: true,
      }),
    ).toBe(
      "/api/integrations/sentry/start?returnTo=%2Fsettings&mode=install",
    );
  });
});
