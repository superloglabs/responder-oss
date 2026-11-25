import { describe, expect, it } from "vitest";
import {
  bannedSessionUserId,
  emailConfirmationTokenUserId,
  sameSitePath,
} from "./account-security.js";

function token(claims: unknown): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(claims)}.signature`;
}

describe("emailConfirmationTokenUserId", () => {
  it("reads the user the token was issued for", () => {
    expect(emailConfirmationTokenUserId(token({ email: "ada@example.com", userId: "user-1" }))).toBe("user-1");
  });

  it("returns null for a token without a user or that is not a token", () => {
    expect(emailConfirmationTokenUserId(token({ email: "ada@example.com" }))).toBeNull();
    expect(emailConfirmationTokenUserId(token({ userId: 7 }))).toBeNull();
    expect(emailConfirmationTokenUserId("not-a-token")).toBeNull();
    expect(emailConfirmationTokenUserId("a.%%%.c")).toBeNull();
    expect(emailConfirmationTokenUserId(undefined)).toBeNull();
  });
});

describe("sameSitePath", () => {
  it("accepts a path on this site", () => {
    expect(sameSitePath("/invite/abc?x=1")).toBe("/invite/abc?x=1");
  });

  it("refuses other sites and anything that is not a path", () => {
    expect(sameSitePath("https://example.com/")).toBeNull();
    expect(sameSitePath("//example.com/")).toBeNull();
    expect(sameSitePath("/\\example.com")).toBeNull();
    expect(sameSitePath("invite")).toBeNull();
    expect(sameSitePath(undefined)).toBeNull();
  });
});

describe("bannedSessionUserId", () => {
  const now = new Date("2026-11-25T12:00:00Z");

  it("names the person behind a session with an active ban", () => {
    expect(bannedSessionUserId({ user: { banned: true, banExpires: null, id: "user-1" } }, now)).toBe("user-1");
    expect(
      bannedSessionUserId({ user: { banned: true, banExpires: "2026-11-26T00:00:00Z", id: "user-1" } }, now),
    ).toBe("user-1");
  });

  it("ignores sessions without a ban or whose ban has expired", () => {
    expect(bannedSessionUserId({ user: { banned: false, id: "user-1" } }, now)).toBeNull();
    expect(
      bannedSessionUserId({ user: { banned: true, banExpires: new Date("2026-11-25T11:00:00Z"), id: "user-1" } }, now),
    ).toBeNull();
    expect(bannedSessionUserId(null, now)).toBeNull();
  });
});
