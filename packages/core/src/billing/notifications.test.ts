import { afterEach, describe, expect, it, vi } from "vitest";
import {
  billingLimitEmail,
  billingLimitMessage,
  billingLimitPeriodKey,
  watchedChannelIds,
} from "./notifications.js";

describe("billing limit notifications", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("explains the limit and links the recipient to billing", () => {
    expect(billingLimitMessage("https://responder.example/settings/billing")).toBe(
      "Superlog has paused new investigations because this workspace used all 50 included investigations this month. Enable pay as you go ($1.50 per investigation) to resume: https://responder.example/settings/billing",
    );
  });

  it("tells a usage-billed workspace to upgrade its plan", () => {
    expect(billingLimitMessage("https://responder.example/settings/billing", true)).toBe(
      "Superlog has paused new investigations and automation runs because this workspace used its included usage for this billing period. Work already in progress finishes, and new work resumes when the allowance resets. Upgrade the plan to resume now: https://responder.example/settings/billing",
    );
  });

  it("links to billing inside workspace settings", () => {
    vi.stubEnv("CONTROL_PLANE_URL", "https://responder.example");

    expect(billingLimitMessage()).toContain(
      "https://responder.example/settings/billing",
    );
  });

  it("names the workspace in the email and escapes it", () => {
    const email = billingLimitEmail(
      "<Acme>",
      true,
      "https://responder.example/settings/billing",
    );

    expect(email.subject).toBe("Superlog paused new work in <Acme>");
    expect(email.html).toContain("<strong>&lt;Acme&gt;</strong>");
    expect(email.html).toContain(
      '<a href="https://responder.example/settings/billing">Upgrade the plan</a>',
    );
    expect(email.text).toContain(
      "Upgrade the plan to resume now: https://responder.example/settings/billing",
    );
  });

  it("sends one notice per billing period", () => {
    const now = new Date("2026-10-08T12:00:00Z");

    expect(billingLimitPeriodKey(1_800_000_000, now)).toBe("reset:1800000000");
    expect(billingLimitPeriodKey(null, now)).toBe("month:2026-10");
  });

  it("alerts every member channel for an all-channel mention trigger", () => {
    expect(
      watchedChannelIds("slack_mention", [], ["channel-1", "channel-2"]),
    ).toEqual(["channel-1", "channel-2"]);
    expect(
      watchedChannelIds("slack_mention", ["channel-2"], ["channel-1", "channel-2"]),
    ).toEqual(["channel-2"]);
  });

  it("skips configured channels the bot has not joined", () => {
    expect(
      watchedChannelIds("slack_channel", ["channel-1"], ["channel-2"]),
    ).toEqual([]);
    expect(
      watchedChannelIds("slack_mention", ["channel-1", "channel-2"], ["channel-2"]),
    ).toEqual(["channel-2"]);
  });
});
