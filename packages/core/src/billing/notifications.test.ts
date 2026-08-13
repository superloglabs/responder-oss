import { afterEach, describe, expect, it, vi } from "vitest";
import { billingLimitMessage, watchedChannelIds } from "./notifications.js";

describe("billing limit notifications", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("explains the limit and links the recipient to billing", () => {
    expect(billingLimitMessage("https://responder.example/settings/billing")).toBe(
      "Responder has paused new investigations because this workspace used all 50 included investigations this month. Enable pay as you go ($1.50 per investigation) to resume: https://responder.example/settings/billing",
    );
  });

  it("links to billing inside workspace settings", () => {
    vi.stubEnv("CONTROL_PLANE_URL", "https://responder.example");

    expect(billingLimitMessage()).toContain(
      "https://responder.example/settings/billing",
    );
  });

  it("alerts every available channel for an all-channel mention trigger", () => {
    expect(
      watchedChannelIds("slack_mention", [], ["channel-1", "channel-2"]),
    ).toEqual(["channel-1", "channel-2"]);
    expect(
      watchedChannelIds("slack_mention", ["channel-2"], ["channel-1", "channel-2"]),
    ).toEqual(["channel-2"]);
  });
});
