import { describe, expect, it } from "vitest";
import { forgetXClickId, xClickIdCookie } from "./x-click-id";

describe("xClickIdCookie", () => {
  it("stores the click id in a long-lived first-party cookie", () => {
    expect(xClickIdCookie("?twclid=26l6412g5p4iyj65a2oic2ayg2", true)).toBe(
      "responder_twclid=26l6412g5p4iyj65a2oic2ayg2; Max-Age=2592000; Path=/;" +
        " SameSite=Lax; Secure",
    );
  });

  it("omits the Secure attribute for local development over http", () => {
    expect(xClickIdCookie("?twclid=abc123", false)).toBe(
      "responder_twclid=abc123; Max-Age=2592000; Path=/; SameSite=Lax",
    );
  });

  it("ignores visits without a click id", () => {
    expect(xClickIdCookie("", true)).toBeNull();
    expect(xClickIdCookie("?utm_source=x", true)).toBeNull();
  });

  it("rejects click ids that could smuggle cookie attributes", () => {
    expect(xClickIdCookie("?twclid=abc;%20Domain=evil.test", true)).toBeNull();
  });
});

describe("forgetXClickId", () => {
  it("expires a previously stored advertising click id", () => {
    const document = {
      cookie: "",
      location: { protocol: "https:" },
    } as unknown as Document;

    forgetXClickId(document);

    expect(document.cookie).toBe(
      "responder_twclid=; Max-Age=0; Path=/; SameSite=Lax; Secure",
    );
  });
});
