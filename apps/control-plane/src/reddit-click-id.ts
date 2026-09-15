const COOKIE_NAME = "_rdt_cid";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function redditClickIdCookie(
  search: string,
  secure: boolean,
): string | null {
  const clickId = new URLSearchParams(search).get("rdt_cid")?.trim();
  if (!clickId || !/^[A-Za-z0-9_-]{1,255}$/.test(clickId)) return null;
  return (
    `${COOKIE_NAME}=${clickId}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/;` +
    ` SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

/** Persists Reddit's landing-page click id for server-side attribution. */
export function rememberRedditClickId(document: Document = window.document) {
  const cookie = redditClickIdCookie(
    document.location.search,
    document.location.protocol === "https:",
  );
  if (cookie) document.cookie = cookie;
}
