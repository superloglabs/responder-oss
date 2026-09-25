import { describe, expect, it } from "vitest";
import { automationTriggerSchema } from "./config.js";
import { dueScheduleSlot, isValidTimeZone, latestScheduleSlot, scheduleLabel, type AutomationSchedule } from "./schedule.js";

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

  it("describes schedules", () => {
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
  });
});
