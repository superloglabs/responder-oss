import { describe, expect, it } from "vitest";
import { scanConfigurationSchema } from "./config.js";

const channelId = "06060606-0606-4606-8606-060606060606";

describe("scan configuration", () => {
  it("supports off, hourly, and six-hour schedules", () => {
    for (const frequencyHours of [null, 1, 6] as const) {
      expect(
        scanConfigurationSchema.parse({
          frequencyHours,
          slackChannelResourceId: channelId,
        }).frequencyHours,
      ).toBe(frequencyHours);
    }
  });

  it("requires a Slack channel when scheduling is enabled", () => {
    expect(() =>
      scanConfigurationSchema.parse({
        frequencyHours: 1,
        slackChannelResourceId: null,
      }),
    ).toThrow("Choose a Slack channel before enabling scheduled scans");
  });

  it("rejects unsupported frequencies", () => {
    expect(() =>
      scanConfigurationSchema.parse({
        frequencyHours: 12,
        slackChannelResourceId: channelId,
      }),
    ).toThrow();
  });
});
