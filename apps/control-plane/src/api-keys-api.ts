import { apiErrorMessage } from "./agents-api";

export interface WorkspaceApiKey {
  canRevoke: boolean;
  createdAt: string;
  createdBy: { email: string; id: string; name: string };
  id: string;
  lastUsedAt: string | null;
  name: string;
  prefix: string;
}

async function apiKeyJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

export async function fetchApiKeys(): Promise<WorkspaceApiKey[]> {
  return (await apiKeyJson<{ apiKeys: WorkspaceApiKey[] }>("/api/api-keys")).apiKeys;
}

export function createApiKey(name: string): Promise<{ apiKey: WorkspaceApiKey; token: string }> {
  return apiKeyJson("/api/api-keys", {
    body: JSON.stringify({ name }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  await apiKeyJson(`/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function apiKeyUsage(key: Pick<WorkspaceApiKey, "createdBy" | "lastUsedAt">, now = new Date()): string {
  const owner = `Acts as ${key.createdBy.name || key.createdBy.email}`;
  if (!key.lastUsedAt) return `${owner} · Never used`;
  const minutes = Math.floor((now.getTime() - new Date(key.lastUsedAt).getTime()) / 60_000);
  if (minutes < 2) return `${owner} · Used just now`;
  if (minutes < 60) return `${owner} · Used ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${owner} · Used ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${owner} · Used ${days} ${days === 1 ? "day" : "days"} ago`;
}
