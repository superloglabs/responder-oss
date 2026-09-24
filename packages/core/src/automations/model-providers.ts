/** Fixed provider endpoints: credentials are never sent to a caller-supplied URL. */
export const automationModelProviders = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "google", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
] as const;
export type ModelProviderId = typeof automationModelProviders[number]["id"];
export interface AvailableAutomationModel { id: string; name: string }
export function modelProvider(id: string) {
  const provider = automationModelProviders.find(provider => provider.id === id);
  if (!provider) throw new Error("Unsupported model provider");
  return provider;
}
export function supportsAutomationHarness(provider: string, harness: string, subscription = false) {
  if (subscription) return provider === "openai" && harness === "codex";
  if (harness === "opencode") return automationModelProviders.some(item => item.id === provider);
  if (harness === "codex") return provider === "openai";
  return harness === "claude_agent_sdk" && provider === "anthropic";
}
