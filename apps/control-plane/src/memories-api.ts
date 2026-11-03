import { apiErrorMessage } from "./agents-api";
import type { MemoryInput, MemoryType } from "../../../packages/core/src/memories/config";

export type { MemoryInput, MemoryType };

export interface MemoryListItem {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
}

export interface MemoryDetail extends MemoryListItem {
  body: string;
}

async function memoryJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

export async function fetchMemories(): Promise<MemoryListItem[]> {
  return (await memoryJson<{ memories: MemoryListItem[] }>("/api/memories")).memories;
}

export async function fetchMemory(memoryId: string): Promise<MemoryDetail> {
  return (await memoryJson<{ memory: MemoryDetail }>(`/api/memories/${encodeURIComponent(memoryId)}`)).memory;
}

// Creates the memory when `memoryId` is undefined. Returns the memory's ID.
export async function saveMemory(memoryId: string | undefined, input: MemoryInput): Promise<string> {
  const response = await memoryJson<{ memory: { id: string } }>(
    memoryId ? `/api/memories/${encodeURIComponent(memoryId)}` : "/api/memories",
    {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
      method: memoryId ? "PUT" : "POST",
    },
  );
  return response.memory.id;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  await memoryJson(`/api/memories/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
}
