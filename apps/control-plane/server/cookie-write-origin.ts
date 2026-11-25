import type { MiddlewareHandler } from "hono";

// Cross-site request protection for cookie-authenticated writes.
//
// SameSite=Lax keeps the session cookie off cross-site POSTs, but every
// subdomain of the same registrable domain counts as same-site. A page on a
// sibling host could otherwise send a credentialed write with a simple
// content type, which needs no CORS preflight. Browsers send Origin on every
// non-GET request, so a write that carries a session cookie must come from a
// trusted origin.
//
// Requests without a session cookie (API keys, webhooks, OAuth token calls,
// internal cell calls) are not ambient-credentialed and pass through.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SESSION_COOKIE_NAME = /(?:^|\.)(?:session_token|session_data)(?:\.\d+)?$/;

function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => {
    const name = part.split("=", 1)[0]?.trim() ?? "";
    return SESSION_COOKIE_NAME.test(name);
  });
}

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isUntrustedCookieWrite(input: {
  method: string;
  cookieHeader: string | null | undefined;
  origin: string | null | undefined;
  secFetchSite: string | null | undefined;
  trustedOrigins: readonly string[];
}): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return false;
  if (!hasSessionCookie(input.cookieHeader)) return false;
  if (input.origin) {
    const trusted = new Set(
      input.trustedOrigins
        .map(normalizedOrigin)
        .filter((origin): origin is string => origin !== null),
    );
    return !trusted.has(input.origin);
  }
  if (input.secFetchSite) {
    return input.secFetchSite !== "same-origin" && input.secFetchSite !== "none";
  }
  return false;
}

export function cookieWriteOriginGuard(
  trustedOrigins: readonly string[],
): MiddlewareHandler {
  return async function cookieWriteOrigin(context, next) {
    if (
      isUntrustedCookieWrite({
        method: context.req.method,
        cookieHeader: context.req.header("cookie"),
        origin: context.req.header("origin"),
        secFetchSite: context.req.header("sec-fetch-site"),
        trustedOrigins,
      })
    ) {
      return context.json({ error: "Forbidden origin." }, 403);
    }
    await next();
  };
}
