// Schedule triggers run an automation every hour, at a local time each day or
// week, or on a custom cron expression. Slots are computed from the trigger
// alone so any control-plane instance can find the same slot; trigger receipts
// keep each slot to one run.

export type AutomationScheduleFrequency = "hourly" | "daily" | "weekly" | "custom";

export interface AutomationSchedule {
  // Five-field cron expression for custom schedules, read in `timezone`.
  cron?: string;
  frequency: AutomationScheduleFrequency;
  // Local hour for daily and weekly schedules, 0-23.
  hour: number;
  timezone: string;
  // Local day for weekly schedules, 0 is Sunday.
  weekday: number;
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const minuteMs = 60_000;
const quarterHourMs = 15 * minuteMs;
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

interface LocalTime {
  day: number;
  hour: number;
  minute: number;
  month: number;
  weekday: number;
}

function localTime(instant: Date, timezone: string): LocalTime {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { day: "numeric", hour: "numeric", hourCycle: "h23", minute: "numeric", month: "numeric", timeZone: timezone, weekday: "long" });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    month: Number(parts.month),
    weekday: weekdays.indexOf(parts.weekday as typeof weekdays[number]),
  };
}

interface CronFields {
  days: Set<number>;
  hours: Set<number>;
  minutes: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  // Cron runs on a day that matches either field when both are restricted.
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

export const maxCronLength = 255;
const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const weekdayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// February counts 29 days so a schedule for February 29 is accepted.
const monthLengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function cronValue(value: string, min: number, names?: string[]): number {
  const named = names?.indexOf(value.toLowerCase()) ?? -1;
  if (named >= 0) return named + min;
  return /^\d+$/u.test(value) ? Number(value) : Number.NaN;
}

// Parses one field: `*`, values, ranges, and steps, separated by commas.
function parseCronField(field: string, min: number, max: number, names?: string[]): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/iu.exec(part);
    if (!match) return null;
    const [, range = "", stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    let start = min;
    let end = max;
    if (range !== "*") {
      const [first = "", last] = range.split("-");
      start = cronValue(first, min, names);
      // A single value with a step, such as 5/15, runs to the field's end.
      end = last === undefined ? (stepText === undefined ? start : max) : cronValue(last, min, names);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end || step < 1) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronFields | null {
  if (expression.trim().length > maxCronLength) return null;
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) return null;
  const [minuteField = "", hourField = "", dayField = "", monthField = "", weekdayField = ""] = fields;
  const minutes = parseCronField(minuteField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const days = parseCronField(dayField, 1, 31);
  const months = parseCronField(monthField, 1, 12, monthNames);
  // 7 is also Sunday.
  const weekdayValues = parseCronField(weekdayField, 0, 7, weekdayNames);
  if (!minutes || !hours || !days || !months || !weekdayValues) return null;
  const weekdays = new Set([...weekdayValues].map((weekday) => weekday % 7));
  const daysRestricted = !dayField.startsWith("*");
  const weekdaysRestricted = !weekdayField.startsWith("*");
  // Reject dates that never occur, such as February 30.
  if (daysRestricted && !weekdaysRestricted && ![...months].some((month) => [...days].some((day) => day <= (monthLengths[month - 1] ?? 0)))) return null;
  return { days, daysRestricted, hours, minutes, months, weekdays, weekdaysRestricted };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

function matchesCron(cron: CronFields, local: LocalTime): boolean {
  if (!cron.minutes.has(local.minute) || !cron.hours.has(local.hour) || !cron.months.has(local.month)) return false;
  const day = cron.days.has(local.day);
  const weekday = cron.weekdays.has(local.weekday);
  return cron.daysRestricted && cron.weekdaysRestricted ? day || weekday : day && weekday;
}

function slotMatcher(schedule: AutomationSchedule): ((local: LocalTime) => boolean) | null {
  if (schedule.frequency === "custom") {
    const cron = parseCron(schedule.cron ?? "");
    return cron ? (local) => matchesCron(cron, local) : null;
  }
  return (local) => {
    if (local.minute !== 0) return false;
    if (schedule.frequency === "hourly") return true;
    if (local.hour !== schedule.hour) return false;
    return schedule.frequency === "daily" || local.weekday === schedule.weekday;
  };
}

// Returns the most recent slot at or before `now` and after `after`. Every
// time zone offset is a multiple of fifteen minutes, so checking quarter hours
// finds local hours. Custom schedules can run on any minute.
export function latestScheduleSlot(schedule: AutomationSchedule, now: Date, after = new Date(now.getTime() - weekMs - quarterHourMs)): Date | null {
  const matches = slotMatcher(schedule);
  if (!matches) return null;
  const step = schedule.frequency === "custom" ? minuteMs : quarterHourMs;
  for (let time = Math.floor(now.getTime() / step) * step; time > after.getTime(); time -= step) {
    const candidate = new Date(time);
    if (matches(localTime(candidate, schedule.timezone))) return candidate;
  }
  return null;
}

// A slot missed while no control plane was polling still runs within this
// window; older slots are skipped.
const scheduleGraceMs = 60 * 60_000;

// Returns the slot to run now, or null. Slots before `savedAt`, when the
// current settings were saved, belong to earlier settings.
export function dueScheduleSlot(schedule: AutomationSchedule, savedAt: Date, now: Date): Date | null {
  const slot = latestScheduleSlot(schedule, now, new Date(now.getTime() - scheduleGraceMs));
  if (!slot || slot < savedAt) return null;
  return slot;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function scheduleWeekdayName(weekday: number): string {
  return weekdays[weekday] ?? "Monday";
}

// Short description such as "Every hour", "Mondays at 09:00", or
// "Cron 0 9 * * 1-5".
export function scheduleLabel(schedule: Pick<AutomationSchedule, "cron" | "frequency" | "hour" | "weekday">): string {
  if (schedule.frequency === "custom") return `Cron ${schedule.cron ?? ""}`.trim();
  if (schedule.frequency === "hourly") return "Every hour";
  if (schedule.frequency === "daily") return `Daily at ${formatHour(schedule.hour)}`;
  return `${scheduleWeekdayName(schedule.weekday)}s at ${formatHour(schedule.hour)}`;
}
