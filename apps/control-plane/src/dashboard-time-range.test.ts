import { describe, expect, it } from "vitest";
import {
  compactDuration,
  formatFieldTime,
  monthWeeks,
  offsetLabel,
  parseFieldTime,
  parseRangeInput,
  relativeLabel,
  resolveTimeRange,
  rezoneFieldText,
  shiftTimeRange,
  spanLabel,
  startOfDay,
  timeRangeFromParams,
  timeRangeParams,
  triggerText,
  windowText,
  zonedTime,
  zoomOutTimeRange,
  type DashboardTimeRange,
} from "./dashboard-time-range";

const paris = "Europe/Paris";
// 14:52 in Paris.
const now = Date.parse("2026-10-14T12:52:00.000Z");
const at = (iso: string) => Date.parse(iso);

describe("time zones", () => {
  it("converts wall-clock times in a zone to instants and back", () => {
    expect(zonedTime({ day: 14, hour: 14, minute: 52, month: 10, year: 2026 }, paris)).toBe(now);
    expect(zonedTime({ day: 14, hour: 14, minute: 52, month: 10, year: 2026 }, "UTC")).toBe(at("2026-10-14T14:52:00Z"));
    // Across the end of summer time on October 25.
    expect(zonedTime({ day: 26, hour: 12, month: 10, year: 2026 }, paris)).toBe(at("2026-10-26T11:00:00Z"));
    expect(startOfDay(now, paris)).toBe(at("2026-10-13T22:00:00Z"));
    expect(startOfDay(now, paris, -1)).toBe(at("2026-10-12T22:00:00Z"));
    expect(offsetLabel(paris, now)).toBe("UTC+02:00");
    expect(offsetLabel("America/New_York", now)).toBe("UTC-04:00");
  });

  it("formats and reads the From and To fields", () => {
    expect(formatFieldTime(now, paris)).toBe("2026-10-14 14:52:00");
    expect(parseFieldTime("2026-10-14 14:52:00", paris)).toBe(now);
    expect(parseFieldTime("2026-10-14", paris)).toBe(startOfDay(now, paris));
    expect(parseFieldTime("2026-02-30 10:00", paris)).toBeNull();
    expect(parseFieldTime("yesterday", paris)).toBeNull();
    // 02:30 does not exist in Paris on the day summer time starts.
    expect(parseFieldTime("2026-03-29 02:30:00", paris)).toBeNull();
    expect(parseFieldTime("2026-03-29 03:30:00", paris)).toBe(at("2026-03-29T01:30:00Z"));
  });

  it("moves field text to another time zone, keeping the instant", () => {
    expect(rezoneFieldText("2026-10-14 14:52:00", paris, "UTC")).toBe("2026-10-14 12:52:00");
    expect(rezoneFieldText("now", paris, "UTC")).toBe("now");
    expect(rezoneFieldText("not a time", paris, "UTC")).toBe("not a time");
  });
});

describe("labels", () => {
  it("names relative ranges and durations", () => {
    expect(relativeLabel(5)).toBe("Last 5 minutes");
    expect(relativeLabel(60)).toBe("Last 1 hour");
    expect(relativeLabel(1440)).toBe("Last 24 hours");
    expect(relativeLabel(10_080)).toBe("Last 7 days");
    expect(compactDuration(90 * 60_000)).toBe("1h 30m");
    expect(spanLabel(2 * 3_600_000)).toBe("2 hours");
    expect(spanLabel(4 * 86_400_000 - 1000)).toBe("4 days");
    expect(spanLabel(90 * 60_000)).toBe("1h 30m");
  });

  it("describes the trigger for each kind of range", () => {
    expect(triggerText({ kind: "relative", minutes: 60 }, now, paris)).toEqual({
      compact: "1h",
      detail: "13:52 – 14:52",
      label: "Last 1 hour",
    });
    expect(triggerText({ kind: "relative", minutes: 4320 }, now, paris).detail).toBe("Oct 11, 14:52 – now");
    const fixed = { from: at("2026-10-14T11:00:00Z"), kind: "absolute", to: at("2026-10-14T12:30:00Z") } as const;
    expect(triggerText(fixed, now, paris)).toEqual({ compact: "1h 30m", detail: "1h 30m", label: "Oct 14, 13:00 – 14:30" });
    expect(triggerText({ from: startOfDay(now, paris), kind: "absolute", to: null }, now, paris).label).toBe("Today so far");
    const yesterday = { from: startOfDay(now, paris, -1), kind: "absolute", to: startOfDay(now, paris) } as const;
    expect(windowText(yesterday, now, paris)).toBe("Oct 13, 00:00 – 24:00");
  });
});

describe("URL parameters", () => {
  it("round-trips relative and fixed ranges", () => {
    const ranges: DashboardTimeRange[] = [
      { kind: "relative", minutes: 15 },
      { kind: "relative", minutes: 180 },
      { from: now - 3_600_000, kind: "absolute", to: now },
      { from: now - 3_600_000, kind: "absolute", to: null },
    ];
    for (const range of ranges) {
      expect(timeRangeFromParams(timeRangeParams(range, new URLSearchParams("var=1")))).toEqual(range);
    }
    expect(timeRangeParams({ kind: "relative", minutes: 10_080 }, new URLSearchParams()).toString()).toBe("range=7d");
  });

  it("falls back to the last hour for anything it cannot read", () => {
    expect(timeRangeFromParams(new URLSearchParams("range=90d"))).toEqual({ kind: "relative", minutes: 60 });
    expect(timeRangeFromParams(new URLSearchParams("from=nope"))).toEqual({ kind: "relative", minutes: 60 });
  });
});

describe("moving the range", () => {
  it("steps back and forward by the range's length, and forward into now goes live", () => {
    const back = shiftTimeRange({ kind: "relative", minutes: 60 }, -1, now);
    expect(back).toEqual({ from: now - 7_200_000, kind: "absolute", to: now - 3_600_000 });
    expect(shiftTimeRange(back, 1, now)).toEqual({ kind: "relative", minutes: 60 });
  });

  it("zooms out around the centre and returns to the range it was zoomed from", () => {
    expect(zoomOutTimeRange({ kind: "relative", minutes: 60 }, now, null)).toEqual({
      range: { kind: "relative", minutes: 120 },
      zoomedFrom: null,
    });
    const before: DashboardTimeRange = { kind: "relative", minutes: 60 };
    const zoomed: DashboardTimeRange = { from: now - 40 * 60_000, kind: "absolute", to: now - 30 * 60_000 };
    const once = zoomOutTimeRange(zoomed, now, before);
    expect(once).toEqual({ range: { from: now - 45 * 60_000, kind: "absolute", to: now - 25 * 60_000 }, zoomedFrom: before });
    const twice = zoomOutTimeRange(once.range, now, before);
    expect(resolveTimeRange(twice.range, now)).toEqual({ since: now - 55 * 60_000, until: now - 15 * 60_000 });
    expect(zoomOutTimeRange(twice.range, now, before)).toEqual({ range: before, zoomedFrom: null });
  });
});

describe("parseRangeInput", () => {
  const labels = (text: string) => {
    const parsed = parseRangeInput(text, now, paris);
    return parsed.kind === "matches" ? parsed.matches.map((match) => match.label) : parsed;
  };

  it("offers durations for a bare number", () => {
    expect(labels("3")).toEqual(["Last 3 hours", "Last 3 days", "Last 30 minutes", "Last 30 days"]);
  });

  it("reads durations with units", () => {
    expect(labels("15m")).toEqual(["Last 15 minutes"]);
    expect(labels("last 1 hour")).toEqual(["Last 1 hour"]);
    expect(labels("2 weeks")).toEqual(["Last 14 days"]);
    expect(parseRangeInput("45d", now, paris)).toMatchObject({ kind: "invalid", message: "Ranges can be up to 30 days" });
  });

  it("reads phrases into a window with other readings", () => {
    const parsed = parseRangeInput("yesterday 14:00 to 16:00", now, paris);
    expect(parsed).toMatchObject({
      kind: "phrase",
      primary: {
        detail: "2 hours",
        label: "Tue, Oct 13, 14:00 – 16:00",
        range: { from: at("2026-10-13T12:00:00Z"), kind: "absolute", to: at("2026-10-13T14:00:00Z") },
      },
    });
    if (parsed.kind !== "phrase") return;
    expect(parsed.others.map((other) => [other.label, other.detail])).toEqual([
      ["Yesterday", "Oct 13, 00:00 – 24:00"],
      ["Yesterday 14:00 until now", "Oct 13, 14:00 – now"],
    ]);
  });

  it("reads days, times, and ranges up to now", () => {
    expect(parseRangeInput("yesterday", now, paris)).toMatchObject({
      primary: { range: { from: startOfDay(now, paris, -1), to: startOfDay(now, paris) } },
    });
    expect(parseRangeInput("today", now, paris)).toMatchObject({ primary: { label: "Today so far" } });
    expect(parseRangeInput("since 9am", now, paris)).toMatchObject({
      primary: { range: { from: at("2026-10-14T07:00:00Z"), to: null } },
    });
    expect(parseRangeInput("oct 6 to oct 9", now, paris)).toMatchObject({
      primary: { detail: "4 days", range: { from: at("2026-10-05T22:00:00Z"), to: at("2026-10-09T22:00:00Z") } },
    });
    expect(parseRangeInput("2026-10-06 to 2026-10-09", now, paris)).toMatchObject({ kind: "phrase" });
    expect(parseRangeInput("10:00-11:30", now, paris)).toMatchObject({ primary: { detail: "1h 30m" } });
  });

  it("explains an end before the start and suggests fixes", () => {
    const parsed = parseRangeInput("14:00 to 13:00", now, paris);
    expect(parsed).toMatchObject({ kind: "invalid", message: "The end time is before the start time" });
    if (parsed.kind !== "invalid") return;
    expect(parsed.suggestions.map((choice) => [choice.label, choice.detail])).toEqual([
      ["Today, 13:00 – 14:00", "1 hour"],
      ["Yesterday 14:00 – today 13:00", "23 hours"],
    ]);
  });

  it("rejects text it cannot read and starts in the future", () => {
    expect(parseRangeInput("whenever", now, paris)).toMatchObject({ kind: "invalid", message: "That is not a time range" });
    expect(parseRangeInput("16:00 to 17:00", now, paris)).toMatchObject({ message: "The range starts in the future" });
  });
});

describe("monthWeeks", () => {
  it("lays out October 2026 from Monday", () => {
    const weeks = monthWeeks(2026, 10);
    expect(weeks[0]).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(weeks[weeks.length - 1]).toEqual([26, 27, 28, 29, 30, 31, null]);
  });
});
