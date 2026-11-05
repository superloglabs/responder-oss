import { apiErrorMessage } from "./agents-api";
import type { ClaudeRoutine } from "../../../packages/core/src/db/claude-routines";

export type { ClaudeRoutine };

const base = "/api/claude-routines";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

// Null when this workspace cannot use routines, because it has no telemetry.
export async function fetchClaudeRoutines(): Promise<ClaudeRoutine[] | null> {
  const response = await fetch(base);
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => null)) as { routines: ClaudeRoutine[] } | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body?.routines ?? [];
}

export async function createClaudeRoutine(input: { fireUrl: string; name: string; token: string }): Promise<ClaudeRoutine> {
  const body = await request<{ routine: ClaudeRoutine }>("", {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return body.routine;
}

export async function deleteClaudeRoutine(routineId: string): Promise<void> {
  const response = await fetch(`${base}/${encodeURIComponent(routineId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(apiErrorMessage(await response.json().catch(() => null), response.status));
}

// Starts a test session. Returns its URL on claude.ai, when Anthropic sends one.
export async function testClaudeRoutine(routineId: string): Promise<string | null> {
  const body = await request<{ sessionUrl: string | null }>(`/${encodeURIComponent(routineId)}/test`, { method: "POST" });
  return body.sessionUrl;
}

// When the routine was last started, or why the last start failed.
export function claudeRoutineStatus(routine: Pick<ClaudeRoutine, "lastError" | "lastFiredAt">, now = new Date()): string {
  if (routine.lastError) return `Last start failed: ${routine.lastError}`;
  if (!routine.lastFiredAt) return "Not started yet";
  const minutes = Math.floor((now.getTime() - new Date(routine.lastFiredAt).getTime()) / 60_000);
  if (minutes < 2) return "Started just now";
  if (minutes < 60) return `Started ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Started ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `Started ${days} ${days === 1 ? "day" : "days"} ago`;
}
