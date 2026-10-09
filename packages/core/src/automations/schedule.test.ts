import { describe, expect, it } from "vitest";
import { automationTriggerSchema } from "./config.js";
import { dueScheduleSlot, isValidCron, isValidTimeZone, latestScheduleSlot, parseCron, scheduleLabel, type AutomationSchedule } from "./schedule.js";

const schedule = (overrides: Partial<AutomationSchedule>): AutomationSchedule => ({
  frequency: "weekly",
  hour: 9,
  timezone: "UTC",
  weekday: 1,
  ...overrides,
});

describe("automation schedule", () => {
  it("finds the latest hourly slot", () => {
    expect(latestScheduleSlot(schedule({ frequency: "hourly" }), new Date("2026-09-25T10:42:10Z")))
      .toEqual(new Date("2026-09-25T10:00:00Z"));
    expect(latestScheduleSlot(schedule({ frequency: "hourly" }), new Date("2026-09-25T10:00:00Z")))
      .toEqual(new Date("2026-09-25T10:00:00Z"));
  });

  it("finds hourly slots on the local hour in half-hour time zones", () => {
    expect(latestScheduleSlot(schedule({ frequency: "hourly", timezone: "Asia/Kolkata" }), new Date("2026-09-25T10:42:00Z")))
      .toEqual(new Date("2026-09-25T10:30:00Z"));
  });

  it("finds the latest daily slot in the schedule's time zone", () => {
    const daily = schedule({ frequency: "daily", timezone: "America/New_York" });
    expect(latestScheduleSlot(daily, new Date("2026-09-25T14:00:00Z"))).toEqual(new Date("2026-09-25T13:00:00Z"));
    expect(latestScheduleSlot(daily, new Date("2026-09-25T12:59:00Z"))).toEqual(new Date("2026-09-24T13:00:00Z"));
  });

  it("finds the latest weekly slot and follows daylight saving time", () => {
    const weekly = schedule({ timezone: "Europe/London" });
    // Friday 25 September 2026; the previous Monday 09:00 BST is 08:00 UTC.
    expect(latestScheduleSlot(weekly, new Date("2026-09-25T12:00:00Z"))).toEqual(new Date("2026-09-21T08:00:00Z"));
    // After the clocks go back, Monday 09:00 GMT is 09:00 UTC.
    expect(latestScheduleSlot(weekly, new Date("2026-11-03T12:00:00Z"))).toEqual(new Date("2026-11-02T09:00:00Z"));
  });

  it("runs a slot once it passes, within an hour, and only for current settings", () => {
    const hourly = schedule({ frequency: "hourly" });
    const savedAt = new Date("2026-09-25T08:30:00Z");
    expect(dueScheduleSlot(hourly, savedAt, new Date("2026-09-25T09:00:20Z"))).toEqual(new Date("2026-09-25T09:00:00Z"));
    expect(dueScheduleSlot(hourly, savedAt, new Date("2026-09-25T08:45:00Z"))).toBeNull();
    const weekly = schedule({});
    expect(dueScheduleSlot(weekly, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-21T09:59:00Z"))).toEqual(new Date("2026-09-21T09:00:00Z"));
    expect(dueScheduleSlot(weekly, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-21T10:00:00Z"))).toBeNull();
  });

  it("finds the latest custom cron slot in the schedule's time zone", () => {
    const weekdayMornings = schedule({ cron: "30 9 * * 1-5", frequency: "custom", timezone: "America/New_York" });
    // Friday 09:30 in New York is 13:30 UTC.
    expect(latestScheduleSlot(weekdayMornings, new Date("2026-09-25T14:00:00Z"))).toEqual(new Date("2026-09-25T13:30:00Z"));
    // On Sunday the latest slot is Friday's.
    expect(latestScheduleSlot(weekdayMornings, new Date("2026-09-27T14:00:00Z"))).toEqual(new Date("2026-09-25T13:30:00Z"));
    const everyFiveMinutes = schedule({ cron: "*/5 * * * *", frequency: "custom" });
    expect(latestScheduleSlot(everyFiveMinutes, new Date("2026-09-25T10:42:10Z"))).toEqual(new Date("2026-09-25T10:40:00Z"));
  });

  it("runs a custom cron slot due within the last hour", () => {
    const savedAt = new Date("2026-09-25T08:00:00Z");
    const quarterly = schedule({ cron: "15 */6 1 jan,apr,jul,oct *", frequency: "custom" });
    expect(dueScheduleSlot(quarterly, savedAt, new Date("2026-10-01T06:20:00Z"))).toEqual(new Date("2026-10-01T06:15:00Z"));
    expect(dueScheduleSlot(quarterly, savedAt, new Date("2026-10-01T07:15:00Z"))).toBeNull();
    expect(dueScheduleSlot(quarterly, savedAt, new Date("2026-10-02T06:20:00Z"))).toBeNull();
    expect(dueScheduleSlot(schedule({ cron: "not cron", frequency: "custom" }), savedAt, new Date("2026-10-01T06:20:00Z"))).toBeNull();
  });

  it("parses cron expressions", () => {
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("*/15 0-6,22-23 1,15 * sun")).toBe(true);
    expect(isValidCron("0 0 29 2 *")).toBe(true);
    expect(isValidCron("0 9 * * 7")).toBe(true);
    expect(parseCron("0 9 * * 7")?.weekdays).toEqual(new Set([0]));
    expect(parseCron("5/20 * * * *")?.minutes).toEqual(new Set([5, 25, 45]));
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("0 9 * * * *")).toBe(false);
    expect(isValidCron("60 * * * *")).toBe(false);
    expect(isValidCron("0 24 * * *")).toBe(false);
    expect(isValidCron("0 9 0 * *")).toBe(false);
    expect(isValidCron("0 9 * 13 *")).toBe(false);
    expect(isValidCron("0 9 * * 8")).toBe(false);
    expect(isValidCron("5-1 * * * *")).toBe(false);
    expect(isValidCron("*/0 * * * *")).toBe(false);
    expect(isValidCron("@daily")).toBe(false);
    expect(isValidCron(`0 9 * * ${"1,".repeat(60)}1`)).toBe(false);
    // February 30 never occurs.
    expect(isValidCron("0 0 30 2 *")).toBe(false);
  });

  it("runs on either day field when both are restricted", () => {
    const firstOrMonday = schedule({ cron: "0 9 1 * mon", frequency: "custom" });
    // Thursday, October 1.
    expect(latestScheduleSlot(firstOrMonday, new Date("2026-10-01T10:00:00Z"))).toEqual(new Date("2026-10-01T09:00:00Z"));
    // Monday, October 5.
    expect(latestScheduleSlot(firstOrMonday, new Date("2026-10-05T10:00:00Z"))).toEqual(new Date("2026-10-05T09:00:00Z"));
    // A step on day of month leaves it unrestricted, so only Mondays run.
    const mondays = schedule({ cron: "0 9 */1 * mon", frequency: "custom" });
    expect(latestScheduleSlot(mondays, new Date("2026-10-01T10:00:00Z"))).toEqual(new Date("2026-09-28T09:00:00Z"));
  });

  it("describes schedules", () => {
    expect(scheduleLabel(schedule({ cron: "0 9 * * 1-5", frequency: "custom" }))).toBe("Cron 0 9 * * 1-5");
    expect(scheduleLabel(schedule({ frequency: "hourly" }))).toBe("Every hour");
    expect(scheduleLabel(schedule({ frequency: "daily", hour: 7 }))).toBe("Daily at 07:00");
    expect(scheduleLabel(schedule({}))).toBe("Mondays at 09:00");
  });

  it("validates schedule triggers", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(automationTriggerSchema.safeParse({ kind: "schedule", ...schedule({}) }).success).toBe(true);
    expect(automationTriggerSchema.safeParse({ kind: "schedule", ...schedule({ timezone: "Mars/Olympus" }) }).success).toBe(false);
    expect(automationTriggerSchema.safeParse({ kind: "schedule", ...schedule({ hour: 24 }) }).success).toBe(false);
    expect(automationTriggerSchema.safeParse({ kind: "schedule", ...schedule({ cron: "0 9 * * 1-5", frequency: "custom" }) }).success).toBe(true);
    expect(automationTriggerSchema.safeParse({ kind: "schedule", ...schedule({ cron: "0 9 * *", frequency: "custom" }) }).success).toBe(false);
    expect(automationTriggerSchema.safeParse({ kind: "schedule", ...schedule({ frequency: "custom" }) }).success).toBe(false);
  });
});
