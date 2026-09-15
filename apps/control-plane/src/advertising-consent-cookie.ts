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

export function advertisingConsentFromCookie(
  cookieHeader: string,
): AdvertisingConsentChoice | null {
  const prefix = `${advertisingConsentCookieName}=`;
  const cookies = cookieHeader
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(prefix));
  if (cookies.length !== 1) return null;
  const consent = cookies[0].slice(prefix.length);
  return consent === "all" || consent === "essential" ? consent : null;
}

export function allowsAdvertisingTracking(consent: string | null | undefined) {
  return consent === "all";
}
