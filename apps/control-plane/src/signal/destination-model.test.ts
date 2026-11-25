import { describe, expect, it } from "vitest";
import { destinationBlocker, discordProblemText, initialDestination, slackSignInProblem } from "./destination-model";
import { discordWebhookUrlProblem } from "./model";

const slack = { integrationAccountId: "a", channelId: "C1" };
const none = { slack: null, discord: { connected: false } };

describe("findings destination", () => {
  it("starts on the destination the workspace already has", () => {
    expect(initialDestination(none)).toBeNull();
    expect(initialDestination({ slack, discord: { connected: false } })).toBe("slack");
    expect(initialDestination({ slack: null, discord: { connected: true } })).toBe("discord");
  });

  it("says why setup cannot continue yet", () => {
    expect(destinationBlocker(null, none, false)).toBe("Choose Slack or Discord to continue.");
    expect(destinationBlocker("slack", none, false)).toBe("Connect Slack to continue.");
    expect(destinationBlocker("slack", none, true)).toBe("Choose a findings channel to continue.");
    expect(destinationBlocker("slack", { slack, discord: { connected: false } }, true)).toBeNull();
    // A channel saved before Slack was disconnected does not count.
    expect(destinationBlocker("slack", { slack, discord: { connected: false } }, false)).toBe("Connect Slack to continue.");
    expect(destinationBlocker("discord", none, true)).toBe("Connect Discord to continue.");
    expect(destinationBlocker("discord", { slack: null, discord: { connected: true } }, false)).toBeNull();
    // A Slack channel does not count once Discord is chosen.
    expect(destinationBlocker("discord", { slack, discord: { connected: false } }, true)).toBe("Connect Discord to continue.");
  });

  it("explains a failed Slack sign-in", () => {
    expect(slackSignInProblem("access_denied")).toBe("Slack did not connect: the approval was cancelled. Try again, or ask a Slack admin to approve the app.");
    expect(slackSignInProblem("invalid_team")).toBe("Slack did not connect (invalid_team). Try again, or ask a Slack admin to approve the app.");
    expect(slackSignInProblem(null)).toBe("Slack did not connect. Try again, or ask a Slack admin to approve the app.");
  });

  it("explains a Discord webhook that stopped working, with the findings waiting", () => {
    const delivery = { problem: "discord_webhook_gone" as const, since: "2026-11-25T14:10:00Z", waiting: 2, firstExpiresAt: "2026-11-26T11:00:00Z" };
    const text = discordProblemText(delivery, new Date("2026-11-25T14:00:00Z"));
    expect(text).toMatch(/^Discord stopped accepting posts on .+\. The webhook was deleted or changed\. 2 findings are waiting; the first expires in 21 h\.$/u);
    expect(discordProblemText({ ...delivery, waiting: 0, firstExpiresAt: null })).toMatch(/The webhook was deleted or changed\.$/u);
  });
});

describe("Discord webhook URL check", () => {
  const token = "a".repeat(68);

  it("accepts the webhook URLs the server accepts", () => {
    expect(discordWebhookUrlProblem(`https://discord.com/api/webhooks/123456789012345678/${token}`)).toBeNull();
    expect(discordWebhookUrlProblem(` https://canary.discord.com/api/v10/webhooks/123456789012345678/${token}/ `)).toBeNull();
  });

  it("names the common wrong pastes", () => {
    expect(discordWebhookUrlProblem("https://acme.slack.com/archives/C08F1QZ2N4K")).toMatch(/^This is a Slack link\./u);
    expect(discordWebhookUrlProblem("https://discord.com/channels/1/2")).toMatch(/^This is a link to a Discord channel\./u);
    for (const value of ["", "discord", "https://discord.com/api/webhooks/1/short", `https://discord.com.evil.example/api/webhooks/123456789012345678/${token}`]) {
      expect(discordWebhookUrlProblem(value), value).toBe("Paste a Discord webhook URL; it starts with https://discord.com/api/webhooks/.");
    }
  });
});
