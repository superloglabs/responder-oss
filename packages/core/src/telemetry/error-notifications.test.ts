import { describe, expect, it } from "vitest";
import { errorTriggerMatches } from "../automations/config.js";
import { isExceptionIssue } from "./error-issues.js";
import { notifiesErrorIssue } from "./error-notifications.js";

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
