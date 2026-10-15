import { z } from "zod";

// Creates the drains that stream a Vercel installation's traces and logs to
// this cell. Traces arrive as OTLP at the ingest endpoint; logs arrive as
// Vercel JSON at its Vercel adapter. Both authenticate with an ingest key.
// https://vercel.com/docs/rest-api/drains/create-a-new-drain

const VERCEL_API = "https://api.vercel.com";
const REQUEST_TIMEOUT_MS = 15_000;

export const vercelDrainSignals = ["traces", "logs"] as const;
export type VercelDrainSignal = (typeof vercelDrainSignals)[number];

export class VercelDrainError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VercelDrainError";
  }
}

export type VercelDrainTarget = {
  accessToken: string;
  // Null for all of the installation's projects.
  projectIds: string[] | null;
  teamId: string | null;
};

export function vercelDrainPayload(input: {
  ingestKey: string;
  ingestOrigin: string;
  name: string;
  projectIds: string[] | null;
  signal: VercelDrainSignal;
}): Record<string, unknown> {
  const origin = input.ingestOrigin.replace(/\/+$/u, "");
  const headers = { "x-api-key": input.ingestKey };
  return {
    name: `${input.name}-${input.signal}`,
    ...(input.projectIds ? { projectIds: input.projectIds, projects: "some" } : { projects: "all" }),
    ...(input.signal === "traces"
      ? {
          delivery: { encoding: "proto", endpoint: { traces: `${origin}/api/ingest/v1/traces` }, headers, type: "otlphttp" },
          schemas: { trace: { version: "v1" } },
        }
      : {
          delivery: { compression: "gzip", encoding: "ndjson", endpoint: `${origin}/api/ingest/vercel/logs`, headers, type: "http" },
          schemas: { log: { version: "v1" } },
        }),
  };
}

function url(path: string, teamId: string | null): string {
  const target = new URL(path, VERCEL_API);
  if (teamId) target.searchParams.set("teamId", teamId);
  return target.toString();
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } | string } | null;
  const message = typeof body?.error === "string" ? body.error : body?.error?.message;
  return message || `Vercel returned HTTP ${response.status}`;
}

export async function createVercelDrain(
  target: VercelDrainTarget,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(url("/v1/drains", target.teamId), {
    body: JSON.stringify(payload),
    headers: { authorization: `Bearer ${target.accessToken}`, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new VercelDrainError(await errorMessage(response), response.status);
  return z.object({ id: z.string().min(1) }).parse(await response.json()).id;
}

// A drain that is already gone counts as deleted.
export async function deleteVercelDrain(
  target: Pick<VercelDrainTarget, "accessToken" | "teamId">,
  drainId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(url(`/v1/drains/${encodeURIComponent(drainId)}`, target.teamId), {
    headers: { authorization: `Bearer ${target.accessToken}` },
    method: "DELETE",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404) throw new VercelDrainError(await errorMessage(response), response.status);
}

// Creates one drain per signal. When one fails, the drains already created
// are removed so a retry starts clean.
export async function createVercelDrains(
  input: VercelDrainTarget & { ingestKey: string; ingestOrigin: string; name: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<VercelDrainSignal, string>> {
  const created: Partial<Record<VercelDrainSignal, string>> = {};
  try {
    for (const signal of vercelDrainSignals) {
      created[signal] = await createVercelDrain(
        input,
        vercelDrainPayload({ ...input, signal }),
        fetchImpl,
      );
    }
  } catch (error) {
    await Promise.allSettled(Object.values(created).map((id) => deleteVercelDrain(input, id, fetchImpl)));
    throw error;
  }
  return created as Record<VercelDrainSignal, string>;
}
