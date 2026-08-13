import { describe, expect, it } from "vitest";
import {
  investigationStatusPresentation,
  sentryTriggerDetails,
  sourceActionLabel,
  toolInputSummary,
  triggerContext,
  triggerTimestamp,
  traceEventText,
} from "./investigation-presentation";

describe("investigationStatusPresentation", () => {
  it("distinguishes active, clear, issue, and failed states", () => {
    expect(
      investigationStatusPresentation({ status: "investigating", issues: [] }),
    ).toEqual({ label: "Investigating", tone: "info" });
    expect(
      investigationStatusPresentation({ status: "resolved", issues: [] }),
    ).toEqual({ label: "No issues found", tone: "live" });
    expect(
      investigationStatusPresentation({
        status: "resolved",
        issues: [{} as never],
      }),
    ).toEqual({ label: "Issue found", tone: "warning" });
    expect(
      investigationStatusPresentation({
        isReplay: true,
        issues: [],
        replayReport: { issues: [{ title: "Regression" }] } as never,
        status: "resolved",
      }),
    ).toEqual({ label: "Issue found", tone: "warning" });
    expect(
      investigationStatusPresentation({ status: "failed", issues: [] }),
    ).toEqual({ label: "Failed", tone: "danger" });
  });
});

describe("trigger presentation", () => {
  it("uses useful provider context when attributes include it", () => {
    expect(
      triggerContext({
        provider: "slack",
        externalEventId: "event-1",
        title: "Incident",
        body: "Details",
        attributes: { channelName: "#prod-incidents" },
      }),
    ).toBe("Slack · #prod-incidents");
  });

  it("falls back to the provider and names the source action", () => {
    const input = {
      provider: "sentry" as const,
      externalEventId: "event-1",
      title: "Incident",
      body: "Details",
    };
    expect(triggerContext(input)).toBe("Sentry");
    expect(sourceActionLabel(input.provider)).toBe("View in Sentry");
  });

  it("shows the identifiers and timestamp retained from a Slack event", () => {
    const input = {
      provider: "slack" as const,
      externalEventId: "event-1:agent-1",
      title: "Incident",
      body: "Details",
      attributes: {
        channelId: "C123",
        slackEventId: "Ev123",
        timestamp: "1700000000.123456",
      },
    };

    expect(triggerContext(input)).toBe("Slack");
    expect(triggerTimestamp(input)).toBe("2023-11-14T22:13:20.123Z");
  });

  it("structures a Sentry issue body and uses its occurrence time", () => {
    const input = {
      provider: "sentry" as const,
      externalEventId: "event-1:agent-1",
      title: "Malformed JSON",
      body: JSON.stringify({
        shortId: "EXAMPLE-4",
        culprit: "POST /api/plants/marigold",
        level: "error",
        status: "unresolved",
        substatus: "new",
        platform: "node",
        project: { name: "Example", slug: "example" },
        issueType: "error",
        priority: "high",
        count: "3",
        userCount: 2,
        lastSeen: "2026-08-03T15:31:20.727Z",
        metadata: {
          type: "SyntaxError",
          value: "Expected a property name",
          filename: "app://server.js",
          function: "parseRequest",
        },
      }),
    };

    expect(sentryTriggerDetails(input)).toMatchObject({
      shortId: "EXAMPLE-4",
      culprit: "POST /api/plants/marigold",
      projectName: "Example",
      priority: "high",
      count: "3",
      userCount: 2,
      errorType: "SyntaxError",
      functionName: "parseRequest",
    });
    expect(triggerTimestamp(input)).toBe("2026-08-03T15:31:20.727Z");
  });

  it("falls back when a Sentry body is not structured JSON", () => {
    expect(
      sentryTriggerDetails({
        provider: "sentry",
        externalEventId: "event-1",
        title: "Legacy trigger",
        body: "Plain-text Sentry trigger",
      }),
    ).toBeNull();
  });
});

describe("trace presentation", () => {
  it("reads finalized message and reasoning text", () => {
    expect(
      traceEventText({
        type: "message.completed",
        data: { message: "I found the failing request." },
      }),
    ).toBe("I found the failing request.");
    expect(
      traceEventText({
        type: "reasoning.completed",
        data: { reasoning: "The deploy is the strongest correlation." },
      }),
    ).toBe("The deploy is the strongest correlation.");
  });

  it("summarizes the most useful tool argument", () => {
    expect(toolInputSummary({ query: "status:error service:checkout" })).toBe(
      "status:error service:checkout",
    );
    expect(toolInputSummary({ limit: 20 })).toBeNull();
  });
});
