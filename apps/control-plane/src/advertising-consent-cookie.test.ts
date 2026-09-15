import { describe, expect, it } from "vitest";
import {
  advertisingConsentCookie,
  advertisingConsentCookieName,
  advertisingConsentFromCookie,
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

  it("reads the choice from a browser cookie string", () => {
    expect(
      advertisingConsentFromCookie(
        "session=one; responder_advertising_consent=all; preference=two",
      ),
    ).toBe("all");
    expect(
      advertisingConsentFromCookie(
        "responder_advertising_consent=essential",
      ),
    ).toBe("essential");
    expect(
      advertisingConsentFromCookie(
        "responder_advertising_consent=unexpected",
      ),
    ).toBeNull();
    expect(advertisingConsentFromCookie("session=one")).toBeNull();
  });

  it("allows advertising only after opt-in", () => {
    expect(allowsAdvertisingTracking("all")).toBe(true);
    expect(allowsAdvertisingTracking("essential")).toBe(false);
    expect(allowsAdvertisingTracking(null)).toBe(false);
    expect(allowsAdvertisingTracking(undefined)).toBe(false);
  });
});
