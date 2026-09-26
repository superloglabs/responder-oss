// Schedule triggers run an automation every hour, or at a local time each day
// or week. Slots are computed from the trigger alone so any control-plane
// instance can find the same slot; trigger receipts keep each slot to one run.

export type AutomationScheduleFrequency = "hourly" | "daily" | "weekly";

export interface AutomationSchedule {
  frequency: AutomationScheduleFrequency;
  // Local hour for daily and weekly schedules, 0-23.
  hour: number;
  timezone: string;
  // Local day for weekly schedules, 0 is Sunday.
  weekday: number;
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const quarterHourMs = 15 * 60_000;
const weekMs = 7 * 24 * 60 * 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function localTime(instant: Date, timezone: string): { hour: number; minute: number; weekday: number } {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", minute: "numeric", timeZone: timezone, weekday: "long" });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday as typeof weekdays[number]),
  };
}

function matchesSlot(schedule: AutomationSchedule, instant: Date): boolean {
  const local = localTime(instant, schedule.timezone);
  if (schedule.frequency === "hourly") return local.minute === 0;
  // A daily or weekly slot is the first quarter hour of a local day at or
  // after the hour. When clocks go back the repeated hour does not run again,
  // and when they skip the hour the slot moves to the first time after it,
  // even when that time falls on the next day.
  const target = schedule.hour * 60;
  const minutes = local.hour * 60 + local.minute;
  const previous = localTime(new Date(instant.getTime() - quarterHourMs), schedule.timezone);
  const previousMinutes = previous.hour * 60 + previous.minute;
  let day: number | null = null;
  if (previous.weekday === local.weekday) {
    if (previousMinutes < target && minutes >= target) day = local.weekday;
  } else if (minutes >= target) {
    day = local.weekday;
  } else if (previousMinutes < target) {
    day = previous.weekday;
  }
  if (day === null) return false;
  return schedule.frequency === "daily" || day === schedule.weekday;
}

// Returns the most recent slot at or before `now`. Every time zone offset is
// a multiple of fifteen minutes, so checking quarter hours finds local hours.
export function latestScheduleSlot(schedule: AutomationSchedule, now: Date): Date | null {
  const start = Math.floor(now.getTime() / quarterHourMs) * quarterHourMs;
  for (let time = start; time > start - weekMs - quarterHourMs; time -= quarterHourMs) {
    const candidate = new Date(time);
    if (matchesSlot(schedule, candidate)) return candidate;
  }
  return null;
}

// A slot missed while no control plane was polling still runs within this
// window; older slots are skipped.
const scheduleGraceMs = 60 * 60_000;

// Returns the slot to run now, or null. Slots before `savedAt`, when the
// current settings were saved, belong to earlier settings.
export function dueScheduleSlot(schedule: AutomationSchedule, savedAt: Date, now: Date): Date | null {
  const slot = latestScheduleSlot(schedule, now);
  if (!slot || slot < savedAt || now.getTime() - slot.getTime() >= scheduleGraceMs) return null;
  return slot;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function scheduleWeekdayName(weekday: number): string {
  return weekdays[weekday] ?? "Monday";
}

// Short description such as "Every hour" or "Mondays at 09:00".
export function scheduleLabel(schedule: Pick<AutomationSchedule, "frequency" | "hour" | "weekday">): string {
  if (schedule.frequency === "hourly") return "Every hour";
  if (schedule.frequency === "daily") return `Daily at ${formatHour(schedule.hour)}`;
  return `${scheduleWeekdayName(schedule.weekday)}s at ${formatHour(schedule.hour)}`;
}
