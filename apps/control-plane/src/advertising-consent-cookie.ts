export type AdvertisingConsentChoice = "all" | "essential";

export const advertisingConsentCookieName =
  "responder_advertising_consent";
const advertisingConsentMaxAgeSeconds = 60 * 60 * 24 * 365;

export function advertisingConsentCookie(
  consent: AdvertisingConsentChoice,
  secure: boolean,
) {
  return (
    `${advertisingConsentCookieName}=${consent};` +
    ` Max-Age=${advertisingConsentMaxAgeSeconds}; Path=/;` +
    ` SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

export function allowsAdvertisingTracking(consent: string | null | undefined) {
  return consent === "all";
}
