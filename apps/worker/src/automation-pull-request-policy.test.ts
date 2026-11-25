import { describe, expect, it } from "vitest";
import {
  automationPullRequestPolicy,
  memberApprovedThisTurn,
  untrustedAutomationTrigger,
} from "./automation-pull-request-policy.js";

const transcript = { data: { items: [], truncated: false }, type: "transcript" };
const message = (data: Record<string, unknown>) => ({ data: { authorId: "U1", authorName: "Ada", text: "ok", ...data }, type: "user_message" });
const button = (pressedByTeamMember?: boolean) => message({
  slackButton: {
    channelId: "C1",
    integrationAccountId: "account",
    label: "Open pull request",
    messageTimestamp: "1.1",
    ...(pressedByTeamMember === undefined ? {} : { pressedByTeamMember }),
    threadTimestamp: "1.1",
  },
  source: "slack",
});

describe("automation pull request trust", () => {
  it("trusts only runs a workspace member started", () => {
    expect(untrustedAutomationTrigger({ provider: "manual" })).toBe(false);
    for (const provider of ["sentry", "errors", "webhook", "schedule", "slack", "discord", "github", "axiom", "devrev", undefined]) {
      expect(untrustedAutomationTrigger({ provider })).toBe(true);
    }
  });

  it("counts a member's message or a team member's button press in this turn as approval", () => {
    expect(memberApprovedThisTurn([message({ text: "Alert fired" })])).toBe(true);
    expect(memberApprovedThisTurn([transcript, message({})])).toBe(true);
    expect(memberApprovedThisTurn([transcript, button(true)])).toBe(true);
  });

  it("does not count Slack replies, outside or unknown presses, GitHub reviews, or earlier turns", () => {
    expect(memberApprovedThisTurn([])).toBe(false);
    expect(memberApprovedThisTurn([transcript])).toBe(false);
    expect(memberApprovedThisTurn([transcript, message({ source: "slack" })])).toBe(false);
    expect(memberApprovedThisTurn([transcript, button(false)])).toBe(false);
    expect(memberApprovedThisTurn([transcript, button()])).toBe(false);
    expect(memberApprovedThisTurn([transcript, message({ source: "github" })])).toBe(false);
    expect(memberApprovedThisTurn([message({}), transcript, message({ source: "slack" })])).toBe(false);
  });

  it("waits for approval only when the workspace asks for it and an outside event started the run", () => {
    const outside = { provider: "sentry" };
    expect(automationPullRequestPolicy({
      allowDependencyChanges: false,
      conversation: [transcript],
      requireApproval: true,
      triggerInput: outside,
    })).toEqual({ allowDependencyChanges: false, awaitingApproval: true, untrustedTrigger: true });
    expect(automationPullRequestPolicy({
      allowDependencyChanges: true,
      conversation: [transcript, button(true)],
      requireApproval: true,
      triggerInput: outside,
    })).toEqual({ allowDependencyChanges: true, awaitingApproval: false, untrustedTrigger: true });
    expect(automationPullRequestPolicy({
      allowDependencyChanges: false,
      conversation: [],
      requireApproval: false,
      triggerInput: outside,
    }).awaitingApproval).toBe(false);
    expect(automationPullRequestPolicy({
      allowDependencyChanges: false,
      conversation: [],
      requireApproval: true,
      triggerInput: { provider: "manual" },
    })).toEqual({ allowDependencyChanges: false, awaitingApproval: false, untrustedTrigger: false });
  });
});
