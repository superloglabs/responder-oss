import { describe, expect, it } from "vitest";
import { issueDateGroupLabel } from "./issues-presentation";

describe("issueDateGroupLabel", () => {
  const now = new Date(2026, 7, 11, 9, 30);

  it("labels issues from today and yesterday", () => {
    expect(issueDateGroupLabel(new Date(2026, 7, 11, 0, 5).toISOString(), now)).toBe(
      "Today",
    );
    expect(issueDateGroupLabel(new Date(2026, 7, 10, 23, 55).toISOString(), now)).toBe(
      "Yesterday",
    );
  });

  it("formats older dates with an unambiguous year", () => {
    expect(
      issueDateGroupLabel(new Date(2026, 7, 9, 12).toISOString(), now, "en-US"),
    ).toBe("August 9, 2026");
  });

  it("uses calendar dates across daylight-saving time changes", () => {
    const afterClockChange = new Date(2026, 2, 30, 0, 30);
    const beforeClockChange = new Date(2026, 2, 29, 0, 30);

    expect(
      issueDateGroupLabel(beforeClockChange.toISOString(), afterClockChange),
    ).toBe("Yesterday");
  });
});
