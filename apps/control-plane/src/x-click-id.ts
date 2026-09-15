import { adClickIdCookie, rememberAdClickId } from "./ad-click-id";

const xClickIdOptions = {
  cookieName: "responder_twclid",
  queryParameter: "twclid",
};

export function xClickIdCookie(search: string, secure: boolean): string | null {
  return adClickIdCookie(search, secure, xClickIdOptions);
}

/**
 * Persists the X ads click id from the landing URL in a first-party cookie so
 * the signup request carries it to the server, where the conversion is
 * reported to X out of reach of content blockers.
 */
export function rememberXClickId(document: Document = window.document) {
  rememberAdClickId(document, xClickIdOptions);
}
