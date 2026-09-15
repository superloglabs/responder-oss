import { describe, expect, it } from "vitest";
import {
  advertisingConsentCookie,
  advertisingConsentCookieName,
  allowsAdvertisingTracking,
} from "./advertising-consent-cookie";

describe("advertising consent cookie", () => {
  it("persists an explicit choice for client and server tracking", () => {
    expect(advertisingConsentCookieName).toBe(
      "responder_advertising_consent",
    );
    expect(advertisingConsentCookie("all", true)).toBe(
      "responder_advertising_consent=all; Max-Age=31536000; Path=/; SameSite=Lax; Secure",
    );
    expect(advertisingConsentCookie("essential", false)).toBe(
      "responder_advertising_consent=essential; Max-Age=31536000; Path=/; SameSite=Lax",
    );
  });

  it("allows advertising only after opt-in", () => {
    expect(allowsAdvertisingTracking("all")).toBe(true);
    expect(allowsAdvertisingTracking("essential")).toBe(false);
    expect(allowsAdvertisingTracking(null)).toBe(false);
    expect(allowsAdvertisingTracking(undefined)).toBe(false);
  });
});
