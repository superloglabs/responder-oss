import { describe, expect, it } from "vitest";
import { investigationPrompt, investigationRequestSchema } from "./input.js";

describe("investigation input", () => {
  it("normalizes a provider event into a bounded investigation", () => {
    const parsed = investigationRequestSchema.parse({
      agentId: "06060606-0606-4606-8606-060606060606",
      provider: "sentry",
      externalEventId: "event-1842",
      title: "Elevated checkout errors",
      body: "Timeouts started after the latest deploy.",
      sourceUrl: "https://sentry.example/issues/1842",
    });

    const prompt = investigationPrompt(parsed);

    expect(prompt).toContain("# sentry event");
    expect(prompt).toContain(parsed.title);
    expect(prompt).toContain(parsed.body);
  });

  it("rejects unknown providers", () => {
    expect(() =>
      investigationRequestSchema.parse({
        agentId: "06060606-0606-4606-8606-060606060606",
        provider: "email",
        externalEventId: "event-1",
        title: "Alert",
        body: "Details",
      }),
    ).toThrow();
  });

  it("renders normalized AWS alarm context for a Slack-triggered investigation", () => {
    const prompt = investigationPrompt({
      attributes: {
        awsAlarmName: "responder-e2e-lambda-errors",
        awsAlarmRegion: "eu-west-3",
        awsAlarmState: "ALARM",
        awsAlarmUrl:
          "https://eu-west-3.console.aws.amazon.com/cloudwatch/home?region=eu-west-3#alarmsV2:alarm/responder-e2e-lambda-errors",
        slackAlertProvider: "aws",
      },
      body: "Threshold crossed.",
      externalEventId: "EvAwsAlarm",
      provider: "slack",
      sourceUrl: "https://slack.com/archives/C123/p123",
      title: "Lambda errors",
    });

    expect(prompt).toContain("AWS alarm context:");
    expect(prompt).toContain("Alarm: responder-e2e-lambda-errors");
    expect(prompt).toContain("State: ALARM");
    expect(prompt).toContain("Region: eu-west-3");
    expect(prompt).toContain("Alarm details: https://eu-west-3.console.aws.amazon.com");
  });

  it("rejects executable source links before they can be rendered", () => {
    expect(() =>
      investigationRequestSchema.parse({
        agentId: "06060606-0606-4606-8606-060606060606",
        body: "An alert was triggered.",
        externalEventId: "event-1",
        provider: "sentry",
        sourceUrl: "javascript:alert(document.domain)",
        title: "Production alert",
      }),
    ).toThrow("Investigation source URLs must use HTTP or HTTPS");
  });
});
