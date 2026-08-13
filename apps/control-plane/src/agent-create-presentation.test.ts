import { describe, expect, it } from "vitest";
import { slackContextConnectionStatus } from "./agent-create-presentation";

describe("slackContextConnectionStatus", () => {
  it("requires a current user grant before showing saved channels as connected", () => {
    expect(
      slackContextConnectionStatus({
        available: false,
        selectedChannelCount: 2,
      }),
    ).toBe("not_connected");
  });

  it("distinguishes an available workspace from configured channel context", () => {
    expect(
      slackContextConnectionStatus({
        available: true,
        selectedChannelCount: 0,
      }),
    ).toBe("available");
    expect(
      slackContextConnectionStatus({
        available: true,
        selectedChannelCount: 2,
      }),
    ).toBe("connected");
  });
});
