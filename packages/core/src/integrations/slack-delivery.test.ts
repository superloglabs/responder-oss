import { describe, expect, it } from "vitest";
import { slackIssueMessage } from "./slack-delivery.js";

describe("Slack issue delivery", () => {
  it("shows root cause and an ordered timeline in the issue message", () => {
    const message = slackIssueMessage({
      id: "07070707-0707-4707-8707-070707070707",
      title: "Organization provisioning race",
      description: "The first authenticated request failed before the organization existed.",
      rootCause: "An authentication change redirected new users before organization provisioning completed.",
      timeline: [
        {
          title: "User logged in",
          description: "The user completed authentication and entered the application.",
        },
        {
          title: "User opened the dashboard",
          description: "The dashboard requested organization-scoped data before provisioning completed.",
        },
        {
          title: "Request failed",
          description: "The API could not resolve an organization and returned a 500 response.",
        },
      ],
      severity: "SEV-2",
      remediation: "Wait for organization provisioning before redirecting the user.",
      relationship: "new",
      evidence: [],
    });

    expect(message.text).toContain("Root cause: An authentication change");
    expect(message.text).toContain("3. Request failed — The API could not resolve");
    expect(message.blocks).toEqual([
      expect.objectContaining({
        type: "section",
        text: expect.objectContaining({
          text: expect.stringContaining("*Timeline*\n1. *User logged in*"),
        }),
      }),
      expect.objectContaining({ type: "actions" }),
    ]);
  });
});
