import { describe, expect, it } from "vitest";
import { settingsBody, withSettingsDefaults } from "./model";
import { capOptions, maxSkippedServices, skippedServiceError } from "./settings-model";

describe("Signal settings", () => {
  it("offers the daily caps up to the most allowed", () => {
    expect(capOptions(50, null)).toEqual([10, 25, 50]);
    expect(capOptions(60, null)).toEqual([10, 25, 50, 60]);
    expect(capOptions(500, null)).toEqual([10, 25, 50, 100, 200, 500]);
    expect(capOptions(5, null)).toEqual([5]);
    expect(capOptions(50, 30)).toEqual([10, 25, 30, 50]);
  });

  it("accepts service names and prefixes the server accepts", () => {
    expect(skippedServiceError("load-tester", [])).toBeNull();
    expect(skippedServiceError("staging-*", [])).toBeNull();
    expect(skippedServiceError("svc:a/b.c_d", [])).toBeNull();
    expect(skippedServiceError("", [])).toBe("Enter a service name.");
    expect(skippedServiceError("*", [])).not.toBeNull();
    expect(skippedServiceError("a*b", [])).not.toBeNull();
    expect(skippedServiceError("two words", [])).not.toBeNull();
    expect(skippedServiceError("a".repeat(201), [])).toBe("Use 200 characters or fewer.");
    expect(skippedServiceError("api", ["api"])).toBe("api is already skipped.");
    expect(skippedServiceError("api", Array.from({ length: maxSkippedServices }, (_, index) => `s${index}`))).not.toBeNull();
  });

  it("fills settings an older server leaves out, and sends no read-only fields", () => {
    const settings = withSettingsDefaults({ enabled: true, setupComplete: true, slack: null, repositoryIds: ["r"] });
    expect(settings).toMatchObject({
      minimumSeverity: "SEV-3", dailyInvestigationCap: null, dismissalCooldownHours: 24, skippedServices: [], notes: "",
      limits: { dailyInvestigationCap: 50 },
    });
    expect(Object.keys(settingsBody(settings)).sort()).toEqual([
      "dailyInvestigationCap", "dismissalCooldownHours", "enabled", "minimumSeverity", "notes", "repositoryIds", "skippedServices", "slack",
    ]);
  });
});
