import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  cookieWriteOriginGuard,
  isUntrustedCookieWrite,
} from "./cookie-write-origin.js";

const trusted = ["https://app.example.com", "https://us.example.com/"];
const session = "__Secure-responder-auth.session_token=tok.sig";

function check(input: {
  method?: string;
  cookie?: string;
  origin?: string;
  secFetchSite?: string;
}) {
  return isUntrustedCookieWrite({
    method: input.method ?? "POST",
    cookieHeader: input.cookie ?? session,
    origin: input.origin,
    secFetchSite: input.secFetchSite,
    trustedOrigins: trusted,
  });
}

describe("cookie write origin check", () => {
  it("allows writes from a trusted origin", () => {
    expect(check({ origin: "https://app.example.com" })).toBe(false);
    expect(check({ origin: "https://us.example.com" })).toBe(false);
  });

  it("rejects writes from a sibling subdomain or another site", () => {
    expect(
      check({ origin: "https://docs.example.com", secFetchSite: "same-site" }),
    ).toBe(true);
    expect(check({ method: "DELETE", origin: "https://docs.example.com" })).toBe(
      true,
    );
    expect(check({ method: "PATCH", origin: "https://evil.test" })).toBe(true);
    expect(check({ method: "PUT", origin: "null" })).toBe(true);
  });

  it("judges browser writes without Origin by Sec-Fetch-Site", () => {
    expect(check({ secFetchSite: "same-origin" })).toBe(false);
    expect(check({ secFetchSite: "none" })).toBe(false);
    expect(check({ secFetchSite: "same-site" })).toBe(true);
    expect(check({ secFetchSite: "cross-site" })).toBe(true);
  });

  it("leaves non-browser clients without Origin or Sec-Fetch-Site alone", () => {
    expect(check({})).toBe(false);
  });

  it("leaves reads and cookie-less requests alone", () => {
    expect(check({ method: "GET", origin: "https://docs.example.com" })).toBe(false);
    expect(check({ method: "HEAD", origin: "https://docs.example.com" })).toBe(false);
    expect(check({ method: "OPTIONS", origin: "https://docs.example.com" })).toBe(
      false,
    );
    expect(check({ cookie: "", origin: "https://docs.example.com" })).toBe(false);
    expect(
      check({ cookie: "responder_cell=eu", origin: "https://docs.example.com" }),
    ).toBe(false);
  });

  it("treats any auth session cookie name as a credential", () => {
    for (const cookie of [
      "responder-auth.session_token=tok",
      "__Secure-better-auth.session_token=tok",
      "__Secure-responder-auth.session_data=x",
    ]) {
      expect(check({ cookie, origin: "https://docs.example.com" })).toBe(true);
    }
  });

  it("answers 403 before the handler runs", async () => {
    let ran = false;
    const app = new Hono()
      .use("*", cookieWriteOriginGuard(trusted))
      .post("/api/keys", (context) => {
        ran = true;
        return context.json({ ok: true });
      });

    const blocked = await app.request("/api/keys", {
      method: "POST",
      headers: {
        cookie: session,
        origin: "https://docs.example.com",
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(blocked.status).toBe(403);
    expect(ran).toBe(false);

    const allowed = await app.request("/api/keys", {
      method: "POST",
      headers: { cookie: session, origin: "https://app.example.com" },
    });
    expect(allowed.status).toBe(200);
    expect(ran).toBe(true);
  });
});
