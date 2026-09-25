const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface AdClickIdCookieOptions {
  cookieName: string;
  queryParameter: string;
}

export function adClickIdCookie(
  search: string,
  secure: boolean,
  options: AdClickIdCookieOptions,
): string | null {
  const clickId = new URLSearchParams(search)
    .get(options.queryParameter)
    ?.trim();
  // Ad click ids are opaque URL-safe tokens. Reject anything that could
  // smuggle cookie attributes and cap storage controlled by the landing URL.
  if (!clickId || !/^[A-Za-z0-9_-]{1,255}$/.test(clickId)) return null;
  return (
    `${options.cookieName}=${clickId}; Max-Age=${COOKIE_MAX_AGE_SECONDS};` +
    ` Path=/; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

/**
 * Stores the click id from the landing URL's query string. Callers pass the
 * query captured at page load because the visitor may navigate before granting
 * marketing consent.
 */
export function rememberAdClickId(
  landingSearch: string,
  document: Document,
  options: AdClickIdCookieOptions,
) {
  const cookie = adClickIdCookie(
    landingSearch,
    document.location.protocol === "https:",
    options,
  );
  if (cookie) document.cookie = cookie;
}

export function forgetAdClickId(
  document: Document,
  options: AdClickIdCookieOptions,
) {
  document.cookie = `${options.cookieName}=; Max-Age=0; Path=/`;
}
