import { apiErrorMessage, type AgentOptions } from "./agents-api";

export type AutomationHarness = "codex" | "claude_agent_sdk" | "opencode";
export type { ModelProviderId as AutomationModelProvider, AvailableAutomationModel } from "../../../packages/core/src/automations/model-providers";
import type { ModelProviderId as AutomationModelProvider, AvailableAutomationModel } from "../../../packages/core/src/automations/model-providers";
export type AutomationInferenceSource = "responder" | "byok" | "byos";
export type AutomationRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type AutomationTrigger =
  | {
      channelIds: string[];
      eventMode: "mentions" | "every_message" | "both";
      integrationAccountId: string;
      kind: "slack";
    }
  | {
      eventTypes: Array<"new_issue" | "regression">;
      integrationAccountId: string;
      kind: "sentry";
      projectIds: string[];
    }
  | {
      channelIds: string[];
      integrationAccountId: string;
      kind: "discord";
    };

export interface AutomationConfiguration {
  contextAccountIds: string[];
  harness: AutomationHarness;
  maxModelRequests: number;
  maxOutputTokensPerRequest: number;
  maxRuntimeSeconds: number;
  model: string;
  modelCredentialId: string | null;
  modelProvider: AutomationModelProvider;
  prompt: string;
  repositoryIds: string[];
  toolPolicy: "full";
  trigger: AutomationTrigger;
  workspaceSecretIds: string[];
}

export interface AutomationInput {
  configuration: AutomationConfiguration;
  description: string;
  enabled: boolean;
  name: string;
}

export interface AutomationListItem {
  inferenceSource: AutomationInferenceSource;
  createdAt: string;
  description: string;
  enabled: boolean;
  harness: AutomationHarness;
  id: string;
  model: string;
  modelProvider: AutomationModelProvider;
  name: string;
  trigger: AutomationTrigger;
  updatedAt: string;
  version: number;
}

export interface AutomationRunInferenceUsage {
  costMicros: number | null;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface AutomationRunSummary {
  inferenceUsage: AutomationRunInferenceUsage | null;
  completedAt: string | null;
  createdAt: string;
  failureCategory: string | null;
  failureMessage: string | null;
  id: string;
  resultSummary: string | null;
  startedAt: string | null;
  status: AutomationRunStatus;
  usage: Record<string, unknown> | null;
}

export interface AutomationDetail {
  inferenceSource: AutomationInferenceSource;
  configuration: AutomationConfiguration;
  createdAt: string;
  description: string;
  enabled: boolean;
  id: string;
  name: string;
  runs: AutomationRunSummary[];
  updatedAt: string;
  version: number;
  versionId: string;
}

export interface AutomationCredential {
  authType?: "api_key" | "chatgpt_subscription";
  createdAt: string;
  id: string;
  label: string;
  lastFour: string;
  lastValidatedAt: string | null;
  provider: AutomationModelProvider;
  status: "active" | "invalid";
  updatedAt: string;
}

export interface AutomationOptions extends Omit<AgentOptions, "accounts" | "resources"> {
  accounts: Array<Omit<AgentOptions["accounts"][number], "provider"> & {
    provider: AgentOptions["accounts"][number]["provider"] | "discord";
  }>;
  credentials: AutomationCredential[];
  resources: Array<Omit<AgentOptions["resources"][number], "kind"> & {
    kind: AgentOptions["resources"][number]["kind"] | "discord_channel";
  }>;
}

async function automationJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

export async function fetchAutomations(): Promise<AutomationListItem[]> {
  const response = await automationJson<{ automations: AutomationListItem[] }>(
    "/api/automations",
  );
  return response.automations;
}

export async function fetchAutomation(id: string): Promise<AutomationDetail> {
  const response = await automationJson<{ automation: AutomationDetail }>(
    `/api/automations/${encodeURIComponent(id)}`,
  );
  return response.automation;
}

export function fetchAutomationOptions(): Promise<AutomationOptions> {
  return automationJson<AutomationOptions>("/api/automations/options");
}

export async function saveAutomation(
  automationId: string | undefined,
  input: AutomationInput,
): Promise<string> {
  const response = await automationJson<{
    automationId?: string;
    updated?: boolean;
  }>(automationId
    ? `/api/automations/${encodeURIComponent(automationId)}`
    : "/api/automations", {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: automationId ? "PUT" : "POST",
  });
  return response.automationId ?? automationId!;
}

export async function createAutomationCredential(input: {
  apiKey: string;
  label: string;
  provider: AutomationModelProvider;
}): Promise<string> {
  const response = await automationJson<{ credentialId: string }>(
    "/api/automations/credentials",
    {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  return response.credentialId;
}

export function setAutomationEnabled(id: string, enabled: boolean) {
  return automationJson<{ enabled: boolean }>(
    `/api/automations/${encodeURIComponent(id)}`,
    {
      body: JSON.stringify({ enabled }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
}

export function runAutomation(id: string) {
  return automationJson<{ duplicate: boolean; runId: string }>(
    `/api/automations/${encodeURIComponent(id)}/runs`,
    { method: "POST" },
  );
}

export function cancelAutomationRun(runId: string) {
  return automationJson<{ cancelRequested: boolean }>(
    `/api/automations/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
}

export interface SubscriptionConnection { connectionId: string; userCode: string; verificationUrl: string; interval: number; expiresAt: string }
export function startAutomationSubscription() { return automationJson<SubscriptionConnection>("/api/automations/subscriptions/openai", { method: "POST" }); }
export function pollAutomationSubscription(id: string) { return automationJson<{ status: "pending" | "expired" | "connected" | "failed"; error?: string; credentialId?: string }>(`/api/automations/subscriptions/openai/${encodeURIComponent(id)}/poll`, { method: "POST" }); }
export function cancelAutomationSubscription(id: string) { return automationJson(`/api/automations/subscriptions/openai/${encodeURIComponent(id)}`, { method: "DELETE" }); }

export function fetchAutomationModels(credentialId: string, refresh = false) { return automationJson<{ models: AvailableAutomationModel[] }>(`/api/automations/credentials/${encodeURIComponent(credentialId)}/models${refresh ? "?refresh=true" : ""}`); }

// Models available with included usage, served through AI Gateway.
export function fetchIncludedAutomationModels(provider: AutomationModelProvider) { return automationJson<{ models: AvailableAutomationModel[] }>(`/api/automations/included-models/${encodeURIComponent(provider)}`); }

export async function fetchAutomationCredentials(): Promise<AutomationCredential[]> {
  const response = await automationJson<{ credentials: AutomationCredential[] }>("/api/automations/credentials");
  return response.credentials;
}

export function rotateAutomationCredential(id: string, apiKey: string) {
  return automationJson<{ updated: boolean }>(`/api/automations/credentials/${encodeURIComponent(id)}`, {
    body: JSON.stringify({ apiKey }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

export function deleteAutomationCredential(id: string) {
  return automationJson<{ deleted: boolean }>(`/api/automations/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
}
