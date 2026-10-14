// The time range a dashboard shows: the last few minutes up to now, or a
// fixed window. A fixed window without an end runs up to now, like "Today so
// far". Ranges that end now are live and refresh on their own.
export type DashboardTimeRange =
  | { kind: "relative"; minutes: number }
  | { from: number; kind: "absolute"; to: number | null };

const minuteMs = 60_000;

export const maximumRangeMinutes = 30 * 1440;
export const relativePresets = [5, 15, 30, 60, 180, 360, 1440, 10_080, 43_200];
export const defaultTimeRange: DashboardTimeRange = { kind: "relative", minutes: 60 };

export function isLive(range: DashboardTimeRange): boolean {
  return range.kind === "relative" || range.to === null;
}

export function resolveTimeRange(range: DashboardTimeRange, now: number): { since: number; until: number } {
  if (range.kind === "relative") return { since: now - range.minutes * minuteMs, until: now };
  return { since: range.from, until: range.to ?? now };
}

export function sameTimeRange(a: DashboardTimeRange, b: DashboardTimeRange): boolean {
  if (a.kind === "relative") return b.kind === "relative" && a.minutes === b.minutes;
  return b.kind === "absolute" && a.from === b.from && a.to === b.to;
}

// "15m", "3h", "7d": the form the URL and the compact trigger use.
export function relativeParam(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// A range the URL describes. One the telemetry API would refuse, such as a
// window longer than 30 days, falls back to the last hour.
export function timeRangeFromParams(params: URLSearchParams, now = Date.now()): DashboardTimeRange {
  const from = Date.parse(params.get("from") ?? "");
  if (Number.isFinite(from)) {
    const toParam = params.get("to");
    const to = toParam === null ? null : Date.parse(toParam);
    const end = to ?? now;
    const fits = Number.isFinite(end) && end > from && end - from <= maximumRangeMinutes * minuteMs;
    if (fits) return { from, kind: "absolute", to };
  }
  const match = /^(\d{1,5})([mhd])$/u.exec(params.get("range") ?? "");
  if (match) {
    const minutes = Number(match[1]) * { d: 1440, h: 60, m: 1 }[match[2] as "d" | "h" | "m"];
    if (minutes >= 1 && minutes <= maximumRangeMinutes) return { kind: "relative", minutes };
  }
  return defaultTimeRange;
}

export function timeRangeParams(range: DashboardTimeRange, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("range");
  next.delete("from");
  next.delete("to");
  if (range.kind === "relative") {
    next.set("range", relativeParam(range.minutes));
  } else {
    next.set("from", new Date(range.from).toISOString());
    if (range.to !== null) next.set("to", new Date(range.to).toISOString());
  }
  return next;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export function relativeLabel(minutes: number): string {
  if (minutes % 1440 === 0 && minutes > 1440) return `Last ${plural(minutes / 1440, "day")}`;
  if (minutes % 60 === 0) return `Last ${plural(minutes / 60, "hour")}`;
  return `Last ${plural(minutes, "minute")}`;
}

// "1h 30m", "45m", "4d 2h", rounded to the minute.
export function compactDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / minuteMs));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts = [days ? `${days}d` : "", hours ? `${hours}h` : "", rest ? `${rest}m` : ""].filter(Boolean);
  return parts.slice(0, 2).join(" ") || "0m";
}

// "2 hours" or "4 days" for whole units, otherwise the compact form.
export function spanLabel(milliseconds: number): string {
  const minutes = Math.round(milliseconds / minuteMs);
  if (minutes > 0 && minutes % 1440 === 0) return plural(minutes / 1440, "day");
  if (minutes > 0 && minutes % 60 === 0) return plural(minutes / 60, "hour");
  if (minutes > 0 && minutes < 60) return plural(minutes, "minute");
  return compactDuration(milliseconds);
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

interface ZonedParts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

export function zonedParts(milliseconds: number, timeZone: string): ZonedParts {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      month: "numeric",
      second: "numeric",
      timeZone,
      year: "numeric",
    });
    partFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(milliseconds)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    month: parts.month!,
    second: parts.second!,
    year: parts.year!,
  };
}

function offsetAt(milliseconds: number, timeZone: string): number {
  const parts = zonedParts(milliseconds, timeZone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(milliseconds / 1000) * 1000;
}

// The instant a wall-clock time in the time zone names. Days past the end of
// the month roll over, so day + 1 is the next day.
export function zonedTime(
  fields: { day: number; hour?: number; minute?: number; month: number; second?: number; year: number },
  timeZone: string,
): number {
  const wall = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour ?? 0, fields.minute ?? 0, fields.second ?? 0);
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

export function startOfDay(milliseconds: number, timeZone: string, addDays = 0): number {
  const parts = zonedParts(milliseconds, timeZone);
  return zonedTime({ day: parts.day + addDays, month: parts.month, year: parts.year }, timeZone);
}

export function offsetLabel(timeZone: string, at: number): string {
  const minutes = Math.round(offsetAt(at, timeZone) / minuteMs);
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatClock(milliseconds: number, timeZone: string): string {
  const parts = zonedParts(milliseconds, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatDay(milliseconds: number, timeZone: string, withWeekday = false): string {
  const parts = zonedParts(milliseconds, timeZone);
  const day = `${monthNames[parts.month - 1]} ${parts.day}`;
  if (!withWeekday) return day;
  return `${weekdayNames[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()]}, ${day}`;
}

// "2026-10-14 13:52:00", the form the From and To fields show and accept.
export function formatFieldTime(milliseconds: number, timeZone: string): string {
  const parts = zonedParts(milliseconds, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function parseFieldTime(text: string, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u.exec(text.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((value) => Number(value ?? 0));
  if (month! < 1 || month! > 12 || day! < 1 || day! > 31 || hour! > 23 || minute! > 59 || second! > 59) return null;
  const time = zonedTime({ day: day!, hour, minute, month: month!, second, year: year! }, timeZone);
  // Rejects dates such as February 30, which would roll into March, and
  // times skipped when summer time starts, which would move by an hour.
  const parts = zonedParts(time, timeZone);
  const exact =
    parts.year === year && parts.month === month && parts.day === day &&
    parts.hour === hour && parts.minute === minute && parts.second === second;
  return exact ? time : null;
}

// Field text written for one time zone, rewritten for another so it names
// the same instant. "now" and text that is not a time stay as they are.
export function rezoneFieldText(text: string, from: string, to: string): string {
  const time = parseFieldTime(text, from);
  return time === null ? text : formatFieldTime(time, to);
}

function sameDay(a: number, b: number, timeZone: string): boolean {
  return startOfDay(a, timeZone) === startOfDay(b, timeZone);
}

// An end at midnight reads as 24:00 on the day before, so a whole day is
// "Oct 13, 00:00 – 24:00".
function endText(since: number, until: number, timeZone: string): { clock: string; day: number } {
  if (until > since && formatClock(until, timeZone) === "00:00" && zonedParts(until, timeZone).second === 0) {
    return { clock: "24:00", day: until - 1 };
  }
  return { clock: formatClock(until, timeZone), day: until };
}

// "13:52 – 14:52" for a live range that started today, "Oct 11, 14:52 – now"
// for one that started earlier, and the dates and times of a fixed window.
export function windowText(range: DashboardTimeRange, now: number, timeZone: string): string {
  const { since, until } = resolveTimeRange(range, now);
  if (isLive(range)) {
    return sameDay(since, now, timeZone)
      ? `${formatClock(since, timeZone)} – ${formatClock(now, timeZone)}`
      : `${formatDay(since, timeZone)}, ${formatClock(since, timeZone)} – now`;
  }
  const end = endText(since, until, timeZone);
  const start = `${formatDay(since, timeZone)}, ${formatClock(since, timeZone)}`;
  return sameDay(since, end.day, timeZone)
    ? `${start} – ${end.clock}`
    : `${start} – ${formatDay(end.day, timeZone)}, ${end.clock}`;
}

export function triggerText(
  range: DashboardTimeRange,
  now: number,
  timeZone: string,
): { compact: string; detail: string; label: string } {
  const { since, until } = resolveTimeRange(range, now);
  if (range.kind === "relative") {
    return { compact: relativeParam(range.minutes), detail: windowText(range, now, timeZone), label: relativeLabel(range.minutes) };
  }
  const duration = compactDuration(until - since);
  if (range.to === null) {
    const label = since === startOfDay(now, timeZone)
      ? "Today so far"
      : `Since ${sameDay(since, now, timeZone) ? "" : `${formatDay(since, timeZone)}, `}${formatClock(since, timeZone)}`;
    return { compact: duration, detail: duration, label };
  }
  return { compact: duration, detail: duration, label: windowText(range, now, timeZone) };
}

// A range moved back or forward by its own length. Moving forward into now
// makes it live again.
export function shiftTimeRange(range: DashboardTimeRange, direction: -1 | 1, now: number): DashboardTimeRange {
  const { since, until } = resolveTimeRange(range, now);
  const span = until - since;
  const from = since + direction * span;
  const to = until + direction * span;
  if (to >= now) return { kind: "relative", minutes: clampMinutes(span) };
  return { from, kind: "absolute", to };
}

function clampMinutes(milliseconds: number): number {
  return Math.min(maximumRangeMinutes, Math.max(1, Math.round(milliseconds / minuteMs)));
}

// Doubles the range around its centre. A zoomed range returns to the range
// it was zoomed from once it is as long again.
export function zoomOutTimeRange(
  range: DashboardTimeRange,
  now: number,
  zoomedFrom: DashboardTimeRange | null,
): { range: DashboardTimeRange; zoomedFrom: DashboardTimeRange | null } {
  if (range.kind === "relative" && !zoomedFrom) {
    return { range: { kind: "relative", minutes: Math.min(maximumRangeMinutes, range.minutes * 2) }, zoomedFrom: null };
  }
  const { since, until } = resolveTimeRange(range, now);
  const span = Math.min(maximumRangeMinutes * minuteMs, (until - since) * 2);
  if (zoomedFrom) {
    const previous = resolveTimeRange(zoomedFrom, now);
    if (span >= previous.until - previous.since) return { range: zoomedFrom, zoomedFrom: null };
  }
  const centre = (since + until) / 2;
  let from = Math.round(centre - span / 2);
  let to = from + span;
  if (to >= now) {
    if (!zoomedFrom) return { range: { kind: "relative", minutes: clampMinutes(span) }, zoomedFrom: null };
    to = now;
    from = now - span;
  }
  return { range: { from, kind: "absolute", to }, zoomedFrom };
}

export interface RangeChoice {
  detail: string;
  label: string;
  range: DashboardTimeRange;
}

export type ParsedRangeInput =
  | { kind: "empty" }
  | { kind: "matches"; matches: RangeChoice[] }
  | { kind: "phrase"; others: RangeChoice[]; primary: RangeChoice }
  | { hint: string; kind: "invalid"; message: string; suggestions: RangeChoice[] };

const unitMinutes: Record<string, number> = { d: 1440, h: 60, m: 1, w: 10_080 };

export function relativeChoice(minutes: number, now: number, timeZone: string): RangeChoice {
  const range: DashboardTimeRange = { kind: "relative", minutes };
  return { detail: windowText(range, now, timeZone), label: relativeLabel(minutes), range };
}

export function rangeChoice(range: DashboardTimeRange, now: number, timeZone: string): RangeChoice {
  if (range.kind === "relative") return relativeChoice(range.minutes, now, timeZone);
  const { since, until } = resolveTimeRange(range, now);
  return range.to === null
    ? { detail: windowText(range, now, timeZone), label: triggerText(range, now, timeZone).label, range }
    : { detail: spanLabel(until - since), label: windowText(range, now, timeZone), range };
}

interface Point {
  day: { day: number; month: number; year: number } | null;
  now?: boolean;
  time: { hour: number; minute: number; second: number } | null;
}

const monthPattern = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

function parseDay(text: string, now: number, timeZone: string): Point["day"] | undefined {
  const today = zonedParts(now, timeZone);
  if (text === "today") return { day: today.day, month: today.month, year: today.year };
  if (text === "yesterday") {
    const yesterday = zonedParts(startOfDay(now, timeZone, -1), timeZone);
    return { day: yesterday.day, month: yesterday.month, year: yesterday.year };
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(text);
  if (iso) return { day: Number(iso[3]), month: Number(iso[2]), year: Number(iso[1]) };
  const named =
    new RegExp(`^(${monthPattern})[a-z]*\\.? (\\d{1,2})$`, "u").exec(text) ??
    new RegExp(`^(\\d{1,2}) (${monthPattern})[a-z]*\\.?$`, "u").exec(text);
  if (!named) return undefined;
  const monthText = /\d/u.test(named[1]!) ? named[2]! : named[1]!;
  const day = Number(/\d/u.test(named[1]!) ? named[1] : named[2]);
  const month = monthPattern.split("|").indexOf(monthText.slice(0, 3)) + 1;
  // A date without a year is the most recent one.
  const year = month > today.month || (month === today.month && day > today.day) ? today.year - 1 : today.year;
  return { day, month, year };
}

function parseClock(text: string, bareHour: boolean): Point["time"] | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/u.exec(text);
  if (!match || (!bareHour && match[2] === undefined && !match[4])) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const second = Number(match[3] ?? 0);
  if (match[4]) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (match[4] === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return { hour, minute, second };
}

function parsePoint(text: string, now: number, timeZone: string, bareHour: boolean): Point | undefined {
  if (text === "now") return { day: null, now: true, time: null };
  const day = parseDay(text, now, timeZone);
  if (day) return { day, time: null };
  const time = parseClock(text, bareHour);
  if (time) return { day: null, time };
  // A day then a time, such as "yesterday 14:00" or "oct 13 9am".
  const words = text.split(" ");
  for (let split = words.length - 1; split > 0; split -= 1) {
    const dayPart = parseDay(words.slice(0, split).join(" "), now, timeZone);
    const timePart = parseClock(words.slice(split).join(" "), true);
    if (dayPart && timePart) return { day: dayPart, time: timePart };
  }
  return undefined;
}

function dayWord(milliseconds: number, now: number, timeZone: string): string {
  const start = startOfDay(milliseconds, timeZone);
  if (start === startOfDay(now, timeZone)) return "today";
  if (start === startOfDay(now, timeZone, -1)) return "yesterday";
  return formatDay(milliseconds, timeZone);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "Today, 13:00 – 14:00" or "Yesterday 14:00 – today 13:00".
function spokenWindow(from: number, to: number, now: number, timeZone: string): string {
  const end = endText(from, to, timeZone);
  if (sameDay(from, end.day, timeZone)) {
    return `${capitalize(dayWord(from, now, timeZone))}, ${formatClock(from, timeZone)} – ${end.clock}`;
  }
  return `${capitalize(dayWord(from, now, timeZone))} ${formatClock(from, timeZone)} – ${dayWord(end.day, now, timeZone)} ${end.clock}`;
}

function windowChoice(from: number, to: number, now: number, timeZone: string, label?: string): RangeChoice {
  return {
    detail: spanLabel(to - from),
    label: label ?? spokenWindow(from, to, now, timeZone),
    range: { from, kind: "absolute", to },
  };
}

// The whole of the day `at` falls in: up to now for today.
function wholeDay(at: number, now: number, timeZone: string): RangeChoice {
  const from = startOfDay(at, timeZone);
  if (from === startOfDay(now, timeZone)) {
    const range: DashboardTimeRange = { from, kind: "absolute", to: null };
    return { detail: windowText(range, now, timeZone), label: "Today so far", range };
  }
  const to = startOfDay(at, timeZone, 1);
  const word = dayWord(at, now, timeZone);
  return {
    detail: windowText({ from, kind: "absolute", to }, now, timeZone),
    label: word === "yesterday" ? "Yesterday" : formatDay(at, timeZone, true),
    range: { from, kind: "absolute", to },
  };
}

function sinceChoice(from: number, now: number, timeZone: string): RangeChoice {
  const range: DashboardTimeRange = { from, kind: "absolute", to: null };
  return {
    detail: windowText(range, now, timeZone),
    label: `${capitalize(dayWord(from, now, timeZone))} ${formatClock(from, timeZone)} until now`,
    range,
  };
}

const unreadable: ParsedRangeInput = {
  hint: 'Try "3h", "yesterday", or "14:00 to 15:30".',
  kind: "invalid",
  message: "That is not a time range",
  suggestions: [],
};

const tooLong: ParsedRangeInput = {
  hint: "Pick a shorter range.",
  kind: "invalid",
  message: "Ranges can be up to 30 days",
  suggestions: [],
};

// Reads what someone types into the time picker: a duration such as "3h", a
// bare number, or a phrase such as "yesterday 14:00 to 16:00".
export function parseRangeInput(input: string, now: number, timeZone: string): ParsedRangeInput {
  const text = input.trim().toLowerCase().replace(/[–—]/gu, "-").replace(/\s+/gu, " ").replace(/,/gu, "");
  if (!text) return { kind: "empty" };

  if (/^\d+$/u.test(text)) {
    const typed = Number(text);
    const candidates = [typed * 60, typed * 1440, ...relativePresets.filter((preset) => {
      const short = relativeParam(preset);
      return short.startsWith(text) && Number(short.slice(0, -1)) !== typed;
    })];
    const minutes = [...new Set(candidates)].filter((value) => value >= 1 && value <= maximumRangeMinutes);
    if (minutes.length === 0) return tooLong;
    return { kind: "matches", matches: minutes.slice(0, 5).map((value) => relativeChoice(value, now, timeZone)) };
  }

  const duration = /^(?:last |past )?(\d+) ?(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/u.exec(text);
  if (duration) {
    const minutes = Number(duration[1]) * unitMinutes[duration[2]!.charAt(0)]!;
    if (minutes < 1) return unreadable;
    if (minutes > maximumRangeMinutes) return tooLong;
    return { kind: "matches", matches: [relativeChoice(minutes, now, timeZone)] };
  }

  if (text === "today" || text === "today so far") {
    const primary = wholeDay(now, now, timeZone);
    return { kind: "phrase", others: [], primary };
  }

  const since = /^(?:since|from) (.+)$/u.exec(text);
  const clockPair = /^(\d{1,2}(?::\d{2})?(?: ?[ap]m)?)-(\d{1,2}(?::\d{2})?(?: ?[ap]m)?|now)$/u.exec(text);
  const parts = since ? [since[1]!, "now"] : clockPair ? [clockPair[1]!, clockPair[2]!] : text.split(/ (?:to|until|till|-) /u);
  if (parts.length > 2) return unreadable;
  const start = parsePoint(parts[0]!, now, timeZone, parts.length === 2);
  if (!start || start.now) return unreadable;

  if (parts.length === 1) {
    if (start.day && !start.time) {
      const day = zonedTime(start.day, timeZone);
      if (day > now) return unreadable;
      return { kind: "phrase", others: [], primary: wholeDay(day, now, timeZone) };
    }
    const from = zonedTime({ ...(start.day ?? zonedParts(now, timeZone)), ...start.time }, timeZone);
    if (from > now) return futureStart();
    return { kind: "phrase", others: [], primary: sinceChoice(from, now, timeZone) };
  }

  const end = parsePoint(parts[1]!, now, timeZone, true);
  if (!end) return unreadable;
  const startDay = start.day ?? end.day ?? zonedParts(now, timeZone);
  const from = zonedTime({ ...startDay, ...start.time }, timeZone);
  if (from > now) return futureStart();
  if (end.now) {
    if (now - from > maximumRangeMinutes * minuteMs) return tooLong;
    return { kind: "phrase", others: [], primary: sinceChoice(from, now, timeZone) };
  }
  const endDay = end.day ?? startDay;
  const to = end.time
    ? zonedTime({ ...endDay, ...end.time }, timeZone)
    : zonedTime({ ...endDay, day: endDay.day + 1 }, timeZone);

  if (to <= from) {
    const suggestions: RangeChoice[] = [];
    const startClock = formatClock(from, timeZone);
    const endClock = end.time ? formatClock(to, timeZone) : "00:00";
    if (start.time && end.time && to <= now) suggestions.push(windowChoice(to, from, now, timeZone));
    if (!start.day) {
      const earlier = zonedTime({ ...startDay, day: startDay.day - 1, ...start.time }, timeZone);
      if (to > earlier && to - earlier <= maximumRangeMinutes * minuteMs) suggestions.push(windowChoice(earlier, to, now, timeZone));
    }
    return {
      hint: `Swap them, or add a day: "yesterday ${startClock} to today ${endClock}".`,
      kind: "invalid",
      message: "The end time is before the start time",
      suggestions,
    };
  }
  if (to - from > maximumRangeMinutes * minuteMs) return tooLong;

  const primary = windowChoice(from, to, now, timeZone, previewTitle({ from, kind: "absolute", to }, now, timeZone));
  const others: RangeChoice[] = [];
  const day = wholeDay(from, now, timeZone);
  if (!(day.range.kind === "absolute" && day.range.from === from && day.range.to === to)) others.push(day);
  if (start.time) others.push(sinceChoice(from, now, timeZone));
  return { kind: "phrase", others, primary };
}

// "Tue, Oct 13, 14:00 – 16:00": a fixed window with its weekday.
export function previewTitle(range: DashboardTimeRange, now: number, timeZone: string): string {
  if (range.kind === "relative") return relativeLabel(range.minutes);
  const weekday = formatDay(range.from, timeZone, true).split(",")[0];
  return `${weekday}, ${windowText(range, now, timeZone)}`;
}

function futureStart(): ParsedRangeInput {
  return { hint: "Pick a start time before now.", kind: "invalid", message: "The range starts in the future", suggestions: [] };
}

// Weeks of a month, Monday first, with null for days of other months.
export function monthWeeks(year: number, month: number): Array<Array<number | null>> {
  const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: Array<number | null> = [...Array<null>(first).fill(null), ...Array.from({ length: days }, (_, index) => index + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

export function monthName(month: number): string {
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month - 1]!;
}

// How often a live dashboard reloads: about sixty times across its range,
// between every 15 seconds and every 5 minutes.
export function liveRefreshInterval(range: DashboardTimeRange, now: number): number {
  const { since, until } = resolveTimeRange(range, now);
  return Math.min(5 * minuteMs, Math.max(15_000, (until - since) / 60));
}
