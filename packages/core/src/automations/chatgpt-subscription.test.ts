import { expect, it } from "vitest";
import { parseSubscriptionAuth } from "./chatgpt-subscription.js";
it("accepts native ChatGPT auth caches and preserves refresh data", () => {
  const auth = { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id", access_token: "access", refresh_token: "refresh", account_id: "account" }, last_refresh: new Date().toISOString() };
  expect(parseSubscriptionAuth(JSON.stringify(auth))).toEqual(auth);
});
it("rejects API-key caches and incomplete subscription credentials", () => {
  expect(() => parseSubscriptionAuth(JSON.stringify({ OPENAI_API_KEY: "api-key" }))).toThrow();
  expect(() => parseSubscriptionAuth(JSON.stringify({ tokens: { access_token: "access" } }))).toThrow();
});
