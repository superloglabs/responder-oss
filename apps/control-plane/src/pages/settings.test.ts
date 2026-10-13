import { describe, expect, it } from "vitest";
import { githubNeedsReconnect, integrationActionUrl } from "./settings-presentation";

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
});

describe("GitHub connection health", () => {
  it("asks to reconnect when a GitHub connection failed", () => {
    expect(
      githubNeedsReconnect({
        accounts: [{ status: "connected" }, { status: "error" }],
        id: "github",
      }),
    ).toBe(true);
  });

  it("does not ask while every GitHub connection works", () => {
    expect(
      githubNeedsReconnect({ accounts: [{ status: "connected" }], id: "github" }),
    ).toBe(false);
  });

  it("leaves other providers to their own health checks", () => {
    expect(
      githubNeedsReconnect({ accounts: [{ status: "error" }], id: "sentry" }),
    ).toBe(false);
  });
});
