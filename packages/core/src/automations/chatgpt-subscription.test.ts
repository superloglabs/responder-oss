import { expect, it } from "vitest";
import { parseSubscriptionAuth, runOnlyRefreshToken, subscriptionAccessTokenExpiresAt, subscriptionAuthForSandbox } from "./chatgpt-subscription.js";
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

it("gives the sandbox a cache without any real token", () => {
  const idToken = `header.${Buffer.from(JSON.stringify({
    email: "person@example.com",
    exp: 1_800_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "account", chatgpt_plan_type: "pro" },
  })).toString("base64url")}.real-signature`;
  const auth = { auth_mode: "chatgpt", tokens: { id_token: idToken, access_token: jwt({ exp: 1_800_000_000 }), refresh_token: "stored-refresh-secret", account_id: "account" } };
  const sandboxAuth = subscriptionAuthForSandbox(JSON.stringify(auth), "dtn_secret_abc");
  const { tokens } = parseSubscriptionAuth(sandboxAuth);
  expect(tokens.access_token).toBe("dtn_secret_abc");
  expect(tokens.refresh_token).toBe(runOnlyRefreshToken);
  expect(tokens.account_id).toBe("account");
  expect(tokens.id_token).not.toContain("real-signature");
  expect(JSON.parse(Buffer.from(tokens.id_token.split(".")[1]!, "base64url").toString("utf8"))).toEqual({
    email: "person@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "account", chatgpt_plan_type: "pro" },
  });
  for (const secret of [auth.tokens.access_token, auth.tokens.refresh_token, idToken])
    expect(sandboxAuth).not.toContain(secret);
});

it("refuses anything but a Daytona placeholder as the sandbox access token", () => {
  expect(() => subscriptionAuthForSandbox(authWith("access"), "real-access-token")).toThrow("placeholder");
});
