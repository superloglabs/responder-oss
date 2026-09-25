import {
  adClickIdCookie,
  forgetAdClickId,
  rememberAdClickId,
} from "./ad-click-id";

const redditClickIdOptions = {
  cookieName: "_rdt_cid",
  queryParameter: "rdt_cid",
};

export function redditClickIdCookie(
  search: string,
  secure: boolean,
): string | null {
  return adClickIdCookie(search, secure, redditClickIdOptions);
}

/** Persists Reddit's landing-page click id for server-side attribution. */
export function rememberRedditClickId(
  landingSearch: string,
  document: Document = window.document,
) {
  rememberAdClickId(landingSearch, document, redditClickIdOptions);
}

export function forgetRedditClickId(document: Document = window.document) {
  forgetAdClickId(document, redditClickIdOptions);
}
