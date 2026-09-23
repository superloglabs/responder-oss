import { describe, expect, it } from "vitest";
import { failureReasonWithFindings, scanDateLabel } from "./scan-detail-presentation";

describe("scanDateLabel", () => {
  it("uses the viewer's date order and punctuation", () => {
    const startedAt = "2026-09-14T09:00:00+02:00";
    expect(scanDateLabel(startedAt, "fr-FR", "Europe/Paris")).toBe("14 septembre à 09:00");
  });
});

describe("failureReasonWithFindings", () => {
  it("keeps a failed scan's reason visible beside persisted findings", () => {
    expect(failureReasonWithFindings("failed", "Connector timed out", 2)).toBe("Connector timed out");
    expect(failureReasonWithFindings("failed", null, 2)).toBe("Scan failed.");
  });

  it("leaves empty and successful scans to their existing messages", () => {
    expect(failureReasonWithFindings("failed", "Connector timed out", 0)).toBeNull();
    expect(failureReasonWithFindings("completed", null, 2)).toBeNull();
  });
});
