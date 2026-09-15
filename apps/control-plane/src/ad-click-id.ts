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

export function rememberAdClickId(
  document: Document,
  options: AdClickIdCookieOptions,
) {
  const cookie = adClickIdCookie(
    document.location.search,
    document.location.protocol === "https:",
    options,
  );
  if (cookie) document.cookie = cookie;
}
