import { expect, it } from "vitest";
import { parseSubscriptionAuth, runOnlyRefreshToken, subscriptionAccessTokenExpiresAt, subscriptionAuthForRun } from "./chatgpt-subscription.js";
it("accepts native ChatGPT auth caches and preserves refresh data", () => {
  const auth = { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id", access_token: "access", refresh_token: "refresh", account_id: "account" }, last_refresh: new Date().toISOString() };
  expect(parseSubscriptionAuth(JSON.stringify(auth))).toEqual(auth);
});
it("rejects API-key caches and incomplete subscription credentials", () => {
  expect(() => parseSubscriptionAuth(JSON.stringify({ OPENAI_API_KEY: "api-key" }))).toThrow();
  expect(() => parseSubscriptionAuth(JSON.stringify({ tokens: { access_token: "access" } }))).toThrow();
});

it("rejects oversized native credential caches", () => { expect(() => parseSubscriptionAuth(" ".repeat(131_073))).toThrow(); });

function jwt(claims: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}
function authWith(accessToken: string) {
  return JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "id", access_token: accessToken, refresh_token: "refresh", account_id: "account" } });
}

it("reads the access token expiry", () => {
  expect(subscriptionAccessTokenExpiresAt(authWith(jwt({ exp: 1_800_000_000 })))).toEqual(new Date(1_800_000_000_000));
  expect(subscriptionAccessTokenExpiresAt(authWith(jwt({})))).toBeNull();
  expect(subscriptionAccessTokenExpiresAt(authWith("opaque"))).toBeNull();
  expect(subscriptionAccessTokenExpiresAt(authWith("a.not-json.c"))).toBeNull();
});

it("gives runs a cache without the refresh token", () => {
  const auth = JSON.parse(authWith("access"));
  const forRun = parseSubscriptionAuth(subscriptionAuthForRun(JSON.stringify(auth)));
  expect(forRun.tokens).toEqual({ ...auth.tokens, refresh_token: runOnlyRefreshToken });
  expect(JSON.stringify(forRun)).not.toContain('"refresh"');
});
