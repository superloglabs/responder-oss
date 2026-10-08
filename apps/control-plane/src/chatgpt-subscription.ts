import type { AutomationCredential } from "./automations-api";

// Codex runs use the newest active ChatGPT subscription, which serves fewer
// models than the included catalog.
export function chatGPTSubscription(credentials: AutomationCredential[]): AutomationCredential | undefined {
  return credentials
    .filter((credential) => credential.provider === "openai" && credential.authType === "chatgpt_subscription" && credential.status === "active")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
