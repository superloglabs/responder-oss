import { describe, expect, it } from "vitest";
import { errorTriggerMatches } from "../automations/config.js";
import { isExceptionIssue } from "./error-issues.js";
import { errorNotificationSettingsSchema, errorNotificationTargetKey, notifiesErrorIssue } from "./error-notifications.js";

describe("exceptions only", () => {
  it("counts span exceptions and logs with a stack trace as exceptions", () => {
    expect(isExceptionIssue({ kind: "span", stacktrace: null })).toBe(true);
    expect(isExceptionIssue({ kind: "log", stacktrace: "Traceback (most recent call last):" })).toBe(true);
    // A stack the fingerprint cannot parse is still an exception.
    expect(isExceptionIssue({ kind: "log", stacktrace: "java.lang.IllegalStateException\n\tat Foo.bar(Foo.java:1)" })).toBe(true);
    expect(isExceptionIssue({ kind: "log", stacktrace: null })).toBe(false);
    expect(isExceptionIssue({ kind: "log", stacktrace: "  " })).toBe(false);
  });

  it("posts plain error log lines unless the workspace chose only exceptions", () => {
    const settings = { enabled: true, targets: [] };
    expect(notifiesErrorIssue(settings, false)).toBe(true);
    expect(notifiesErrorIssue({ ...settings, exceptionsOnly: true }, false)).toBe(false);
    expect(notifiesErrorIssue({ ...settings, exceptionsOnly: true }, true)).toBe(true);
    expect(notifiesErrorIssue({ ...settings, enabled: false }, true)).toBe(false);
  });

  it("starts automations for plain error log lines unless the trigger chose only exceptions", () => {
    const trigger = { eventTypes: ["new_issue" as const], kind: "errors" as const };
    const change = { eventType: "new_issue" as const, exception: false, service: "api" };
    expect(errorTriggerMatches(trigger, change)).toBe(true);
    expect(errorTriggerMatches({ ...trigger, exceptionsOnly: true }, change)).toBe(false);
    expect(errorTriggerMatches({ ...trigger, exceptionsOnly: true }, { ...change, exception: true })).toBe(true);
  });
});

describe("error notification destinations", () => {
  const slack = { kind: "slack" as const, integrationAccountId: "00000000-0000-4000-8000-000000000001", channelId: "C123" };
  const routine = { kind: "claude_routine" as const, routineId: "00000000-0000-4000-8000-000000000002" };

  it("accepts a Slack channel, a Claude routine, or both", () => {
    for (const targets of [[slack], [routine], [slack, routine]]) {
      expect(errorNotificationSettingsSchema.safeParse({ enabled: true, targets }).success).toBe(true);
    }
  });

  it("rejects two destinations of one kind and enabled settings without one", () => {
    expect(errorNotificationSettingsSchema.safeParse({ enabled: true, targets: [routine, routine] }).success).toBe(false);
    expect(errorNotificationSettingsSchema.safeParse({ enabled: true, targets: [] }).success).toBe(false);
    expect(errorNotificationSettingsSchema.safeParse({ enabled: false, targets: [] }).success).toBe(true);
  });

  it("keys each destination by kind", () => {
    expect(errorNotificationTargetKey(slack)).toBe(`slack:${slack.integrationAccountId}:C123`);
    expect(errorNotificationTargetKey(routine)).toBe(`claude_routine:${routine.routineId}`);
  });
});
