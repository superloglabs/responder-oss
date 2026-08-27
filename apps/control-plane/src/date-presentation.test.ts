import { describe, expect, it } from "vitest";
import { dateGroupLabel } from "./date-presentation";

describe("dateGroupLabel", () => {
  const now = new Date(2026, 7, 11, 9, 30);

  it("labels dates from today and yesterday", () => {
    expect(dateGroupLabel(new Date(2026, 7, 11, 0, 5).toISOString(), now)).toBe(
      "Today",
    );
    expect(dateGroupLabel(new Date(2026, 7, 10, 23, 55).toISOString(), now)).toBe(
      "Yesterday",
    );
  });

  it("formats older dates with an unambiguous year", () => {
    expect(
      dateGroupLabel(new Date(2026, 7, 9, 12).toISOString(), now, "en-US"),
    ).toBe("August 9, 2026");
  });

  it("uses calendar dates across daylight-saving time changes", () => {
    const afterClockChange = new Date(2026, 2, 30, 0, 30);
    const beforeClockChange = new Date(2026, 2, 29, 0, 30);

    expect(
      dateGroupLabel(beforeClockChange.toISOString(), afterClockChange),
    ).toBe("Yesterday");
  });
});
