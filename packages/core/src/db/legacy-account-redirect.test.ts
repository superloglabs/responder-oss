import { describe, expect, it } from "vitest";
import { legacyProductUrl, normalizeLegacyEmail } from "./legacy-account-redirect.js";

describe("legacy account redirect", () => {
  it("normalizes lookup email without changing its identity", () => {
    expect(normalizeLegacyEmail("  ALI@Example.COM ")).toBe("ali@example.com");
  });

  it("uses the fixed telemetry origin by default", () => {
    expect(legacyProductUrl({})).toBe("https://telemetry.superlog.sh/");
  });

  it("rejects non-HTTPS production redirect origins", () => {
    expect(() => legacyProductUrl({ LEGACY_PRODUCT_URL: "http://evil.example" })).toThrow(
      "LEGACY_PRODUCT_URL must be telemetry.superlog.sh over HTTPS",
    );
  });

  it("allows localhost for local integration tests", () => {
    expect(legacyProductUrl({ LEGACY_PRODUCT_URL: "http://localhost:4173/path" })).toBe(
      "http://localhost:4173/",
    );
  });
});
