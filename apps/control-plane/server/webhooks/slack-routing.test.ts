import { describe, expect, it } from "vitest";
import {
  slackConversationOrganizations,
  slackOutsideAuthorReason,
} from "./slack-routing.js";

describe("slackOutsideAuthorReason", () => {
  it("accepts a member of the team", () => {
    expect(slackOutsideAuthorReason({
      event: { user_team: "T123", user_profile: { team: "T123" } },
      teamId: "T123",
    })).toBeNull();
  });

  it("accepts a message whose author team Slack did not send", () => {
    expect(slackOutsideAuthorReason({ event: {}, teamId: "T123" })).toBeNull();
  });

  it("rejects a person from another team", () => {
    expect(slackOutsideAuthorReason({
      event: { user_team: "T999" },
      externallyShared: true,
      teamId: "T123",
    })).toBe("other_team");
    expect(slackOutsideAuthorReason({
      event: { user_profile: { team: "T999" } },
      teamId: "T123",
    })).toBe("other_team");
  });

  it("rejects guests", () => {
    expect(slackOutsideAuthorReason({
      event: { user_team: "T123", user_profile: { is_restricted: true } },
      teamId: "T123",
    })).toBe("guest");
    expect(slackOutsideAuthorReason({
      event: { user_team: "T123", user_profile: { is_ultra_restricted: true } },
      teamId: "T123",
    })).toBe("guest");
  });

  it("accepts another workspace of the same Enterprise Grid org in a channel not shared outside it", () => {
    expect(slackOutsideAuthorReason({
      enterpriseId: "E123",
      event: { user_team: "T456" },
      externallyShared: false,
      teamId: "T123",
    })).toBeNull();
    expect(slackOutsideAuthorReason({
      enterpriseId: "E123",
      event: { user_team: "T456" },
      externallyShared: true,
      teamId: "T123",
    })).toBe("other_team");
  });
});

describe("slackConversationOrganizations", () => {
  const connections = [{ organizationId: "first" }, { organizationId: "second" }];

  it("leaves routing alone when one organization holds the team", () => {
    expect(slackConversationOrganizations({
      channelOrganizationIds: [],
      connections: [{ organizationId: "first" }],
    })).toBeNull();
    expect(slackConversationOrganizations({ channelOrganizationIds: [], connections: [] })).toBeNull();
  });

  it("picks the first organization to connect when none chose the channel", () => {
    expect(slackConversationOrganizations({ channelOrganizationIds: [], connections })).toEqual(new Set(["first"]));
  });

  it("picks the organizations that chose the channel", () => {
    expect(slackConversationOrganizations({ channelOrganizationIds: ["second"], connections }))
      .toEqual(new Set(["second"]));
  });

  it("ignores a choice from an organization that does not hold the team", () => {
    expect(slackConversationOrganizations({ channelOrganizationIds: ["other"], connections }))
      .toEqual(new Set(["first"]));
  });
});
