import { describe, expect, it } from "vitest";
import type { AutomationCredential } from "./automations-api";
import { chatGPTSubscription } from "./chatgpt-subscription";

function credential(overrides: Partial<AutomationCredential>): AutomationCredential {
  return {
    authType: "chatgpt_subscription",
    createdAt: "2026-10-06T16:12:54.946Z",
    id: "subscription",
    label: "ChatGPT subscription",
    lastFour: "",
    lastValidatedAt: null,
    provider: "openai",
    status: "active",
    updatedAt: "2026-10-06T16:12:54.946Z",
    ...overrides,
  };
}

describe("chatGPTSubscription", () => {
  it("picks the newest active ChatGPT subscription, as Codex runs do", () => {
    expect(chatGPTSubscription([
      credential({ createdAt: "2026-10-01T00:00:00.000Z", id: "older" }),
      credential({ createdAt: "2026-10-06T00:00:00.000Z", id: "newer" }),
      credential({ createdAt: "2026-10-07T00:00:00.000Z", id: "invalid", status: "invalid" }),
    ])?.id).toBe("newer");
  });

  it("ignores API keys", () => {
    expect(chatGPTSubscription([credential({ authType: "api_key", id: "key" })])).toBeUndefined();
  });
});
