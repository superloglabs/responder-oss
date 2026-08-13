import { describe, expect, it } from "vitest";
import { integrationActionUrl } from "./settings-presentation";

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
