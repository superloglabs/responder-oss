import { describe, expect, it } from "vitest";
import { redditClickIdCookie } from "./reddit-click-id";

describe("redditClickIdCookie", () => {
  it("stores the click id in a long-lived first-party cookie", () => {
    expect(redditClickIdCookie("?rdt_cid=reddit-click-1", true)).toBe(
      "_rdt_cid=reddit-click-1; Max-Age=2592000; Path=/; SameSite=Lax; Secure",
    );
  });

  it("omits the Secure attribute for local development over http", () => {
    expect(redditClickIdCookie("?rdt_cid=abc123", false)).toBe(
      "_rdt_cid=abc123; Max-Age=2592000; Path=/; SameSite=Lax",
    );
  });

  it("ignores visits without a click id", () => {
    expect(redditClickIdCookie("", true)).toBeNull();
    expect(redditClickIdCookie("?utm_source=reddit", true)).toBeNull();
  });

  it("rejects click ids that could smuggle cookie attributes", () => {
    expect(
      redditClickIdCookie("?rdt_cid=abc;%20Domain=evil.test", true),
    ).toBeNull();
  });
});
