import { describe, expect, it } from "vitest";
import { failureReasonWithFindings, scanDateLabel } from "./scan-detail-presentation";

describe("scanDateLabel", () => {
  it("uses the viewer's date order and punctuation", () => {
    const startedAt = "2026-09-14T09:00:00+02:00";
    const expected = new Intl.DateTimeFormat("fr-FR", {
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "Europe/Paris",
    }).format(new Date(startedAt));
    expect(scanDateLabel(startedAt, "fr-FR", "Europe/Paris")).toBe(expected);
  });
});

describe("failureReasonWithFindings", () => {
  it("keeps a failed scan's reason visible beside persisted findings", () => {
    expect(failureReasonWithFindings("failed", "Connector timed out", 2)).toBe("Connector timed out");
  });

  it("leaves empty and successful scans to their existing messages", () => {
    expect(failureReasonWithFindings("failed", "Connector timed out", 0)).toBeNull();
    expect(failureReasonWithFindings("completed", null, 2)).toBeNull();
  });
});
