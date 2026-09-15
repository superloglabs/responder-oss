const COOKIE_NAME = "responder_twclid";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function xClickIdCookie(search: string, secure: boolean): string | null {
  const twclid = new URLSearchParams(search).get("twclid");
  // X click ids are opaque alphanumeric tokens; anything else is rejected so
  // a crafted URL cannot smuggle cookie attributes.
  if (!twclid || !/^[\w-]+$/.test(twclid)) return null;
  return (
    `${COOKIE_NAME}=${twclid}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/;` +
    ` SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

/**
 * Persists the X ads click id from the landing URL in a first-party cookie so
 * the signup request carries it to the server, where the conversion is
 * reported to X out of reach of content blockers.
 */
export function rememberXClickId(document: Document = window.document) {
  const cookie = xClickIdCookie(
    document.location.search,
    document.location.protocol === "https:",
  );
  if (cookie) document.cookie = cookie;
}
