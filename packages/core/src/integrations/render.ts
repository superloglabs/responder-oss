import { createHash } from "node:crypto";
import { z } from "zod";

// Render's REST API, read with an API key a person creates in Render's
// Account settings. Render has no OAuth for other apps, and a key reaches
// every Render workspace its creator belongs to, so Superlog only reads
// with it: workspaces, services, and logs.
// https://api-docs.render.com/reference/introduction

export const RENDER_API_URL = "https://api.render.com/v1";

// RENDER_API_URL points the client at another server, such as a local stub
// for tests. Only the operator sets it.
export function renderApiUrl(): string {
  return (process.env.RENDER_API_URL?.trim() || RENDER_API_URL).replace(/\/+$/u, "");
}

export type RenderFetch = (input: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 30_000;
// A page of logs holds at most 100 lines.
const MAX_RESPONSE_BYTES = 10_000_000;
// Lists are read this many items at a time, and no further than this.
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 20;

export const renderCredentialsSchema = z.object({ apiKey: z.string().min(1) });
export type RenderCredentials = z.infer<typeof renderCredentialsSchema>;

export type RenderErrorKind =
  // Render refused the key: it was deleted or its user left the workspace.
  | "unauthorized"
  // Render limits log reads to 30 requests a minute per user, and some
  // pages answer that log retrieval is unavailable. Both pass; read again
  // on the next pass.
  | "retry_later"
  | "failed";

export class RenderApiError extends Error {
  readonly kind: RenderErrorKind;
  readonly status: number | null;

  constructor(message: string, kind: RenderErrorKind, status: number | null) {
    super(message);
    this.name = "RenderApiError";
    this.kind = kind;
    this.status = status;
  }
}

const retryLaterMessages = [/rate limit exceeded/iu, /log retrieval is currently unavailable/iu];

export function renderErrorKind(status: number | null, message: string): RenderErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429 || retryLaterMessages.some((pattern) => pattern.test(message))) return "retry_later";
  return "failed";
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RenderApiError("Render's response was too large", "failed", response.status);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// One GET against Render's API. The key goes only in the authorization
// header; errors carry Render's message, never the key.
async function renderGet(input: {
  apiKey: string;
  fetch?: RenderFetch;
  path: string;
  query?: URLSearchParams;
}): Promise<unknown> {
  const query = input.query?.toString();
  const url = `${renderApiUrl()}${input.path}${query ? `?${query}` : ""}`;
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, {
      headers: { accept: "application/json", authorization: `Bearer ${input.apiKey}` },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RenderApiError(
      `Render could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      "failed",
      null,
    );
  }
  const text = await boundedText(response);
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : text.trim().slice(0, 200) || `HTTP ${response.status}`;
    throw new RenderApiError(`Render answered ${response.status}: ${message}`, renderErrorKind(response.status, message), response.status);
  }
  return body;
}

// Render's lists wrap each item with the cursor that continues after it.
async function renderList<T>(input: {
  apiKey: string;
  fetch?: RenderFetch;
  item: (value: Record<string, unknown>) => T | null;
  key: string;
  path: string;
  query?: Record<string, string>;
}): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query = new URLSearchParams({ ...input.query, limit: String(LIST_PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    const body = await renderGet({ apiKey: input.apiKey, path: input.path, query, ...(input.fetch ? { fetch: input.fetch } : {}) });
    const entries = Array.isArray(body) ? body : [];
    for (const entry of entries) {
      const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>)[input.key] : null;
      const parsed = value && typeof value === "object" ? input.item(value as Record<string, unknown>) : null;
      if (parsed) items.push(parsed);
    }
    if (entries.length < LIST_PAGE_SIZE) break;
    const last = entries.at(-1) as { cursor?: unknown } | undefined;
    cursor = typeof last?.cursor === "string" && last.cursor ? last.cursor : null;
    if (!cursor) break;
  }
  return items;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export type RenderWorkspace = { id: string; name: string };

/** The workspaces the key reaches. Also checks the key. */
export async function renderWorkspaces(input: { apiKey: string; fetch?: RenderFetch }): Promise<RenderWorkspace[]> {
  return renderList({
    ...input,
    item: (owner) => {
      const id = text(owner.id);
      return id ? { id, name: text(owner.name) ?? id } : null;
    },
    key: "owner",
    path: "/owners",
  });
}

/** The person the key belongs to, or null when Render does not say. */
export async function renderUser(input: { apiKey: string; fetch?: RenderFetch }): Promise<{ email: string | null; name: string | null } | null> {
  const body = await renderGet({ ...input, path: "/users" });
  if (!body || typeof body !== "object") return null;
  const user = body as Record<string, unknown>;
  return { email: text(user.email), name: text(user.name) };
}

export type RenderService = {
  id: string;
  name: string;
  ownerId: string;
  // Null where Render does not say, such as for static sites.
  region: string | null;
  suspended: boolean;
  type: string;
};

/** The services in one workspace. */
export async function renderServices(input: { apiKey: string; fetch?: RenderFetch; ownerId: string }): Promise<RenderService[]> {
  return renderList({
    apiKey: input.apiKey,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    item: (service) => {
      const id = text(service.id);
      if (!id) return null;
      const details = service.serviceDetails && typeof service.serviceDetails === "object"
        ? (service.serviceDetails as Record<string, unknown>)
        : {};
      return {
        id,
        name: text(service.name) ?? id,
        ownerId: text(service.ownerId) ?? input.ownerId,
        region: text(details.region) ?? text(service.region),
        suspended: service.suspended === "suspended",
        type: text(service.type) ?? "unknown",
      };
    },
    key: "service",
    path: "/services",
    query: { ownerId: input.ownerId },
  });
}

// What a connection can read: whole workspaces, and each running service.
export type RenderReadable = {
  id: string;
  kind: "service" | "workspace";
  ownerId: string;
  region?: string | null;
  serviceName?: string;
  serviceType?: string;
  workspaceName: string;
};

const MAX_READABLE_WORKSPACES = 20;

/** The workspaces a key reaches and their services, suspended ones left out. */
export async function renderReadables(input: { apiKey: string; fetch?: RenderFetch }): Promise<RenderReadable[]> {
  const readables: RenderReadable[] = [];
  for (const workspace of (await renderWorkspaces(input)).slice(0, MAX_READABLE_WORKSPACES)) {
    readables.push({ id: workspace.id, kind: "workspace", ownerId: workspace.id, workspaceName: workspace.name });
    const services = await renderServices({ ...input, ownerId: workspace.id });
    for (const service of services.filter((item) => !item.suspended)) {
      readables.push({
        id: service.id,
        kind: "service",
        ownerId: workspace.id,
        region: service.region,
        serviceName: service.name,
        serviceType: service.type,
        workspaceName: workspace.name,
      });
    }
  }
  return readables;
}

export type RenderLogLine = {
  id: string | null;
  // Render's log labels: resource, instance, level, type, and for request
  // logs the method, path, status code, and host.
  labels: Array<{ name: string; value: string }>;
  message: string;
  timestamp: string;
};

export type RenderLogsPage = {
  hasMore: boolean;
  logs: RenderLogLine[];
  nextEndTime: string | null;
  nextStartTime: string | null;
};

function logLine(value: unknown): RenderLogLine | null {
  if (!value || typeof value !== "object") return null;
  const line = value as Record<string, unknown>;
  const timestamp = text(line.timestamp);
  if (!timestamp) return null;
  const labels = Array.isArray(line.labels)
    ? line.labels.flatMap((label) => {
      if (!label || typeof label !== "object") return [];
      const { name, value: labelValue } = label as { name?: unknown; value?: unknown };
      return typeof name === "string" && typeof labelValue === "string" ? [{ name, value: labelValue }] : [];
    })
    : [];
  return {
    id: text(line.id),
    labels,
    message: typeof line.message === "string" ? line.message : "",
    timestamp,
  };
}

/**
 * One page of logs, at most 100 lines, from services that share a
 * workspace and a region. Read forward, a page continues at the previous
 * page's nextStartTime while hasMore is true.
 */
export async function renderLogsPage(input: {
  apiKey: string;
  endTime: string;
  fetch?: RenderFetch;
  limit: number;
  ownerId: string;
  resources: string[];
  startTime: string;
}): Promise<RenderLogsPage> {
  const query = new URLSearchParams({
    direction: "forward",
    endTime: input.endTime,
    limit: String(input.limit),
    ownerId: input.ownerId,
    startTime: input.startTime,
  });
  for (const resource of input.resources) query.append("resource", resource);
  const body = await renderGet({
    apiKey: input.apiKey,
    path: "/logs",
    query,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const page = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    hasMore: page.hasMore === true,
    logs: (Array.isArray(page.logs) ? page.logs : []).map(logLine).filter((line): line is RenderLogLine => line !== null),
    nextEndTime: text(page.nextEndTime),
    nextStartTime: text(page.nextStartTime),
  };
}

/**
 * The connection's identity: the key's user, so a new key for the same
 * person replaces the old one. A key whose user Render does not name gets
 * an ID from a hash of the key, which never leaves Superlog.
 */
export function renderExternalAccountId(input: { apiKey: string; email: string | null }): string {
  if (input.email) return input.email.trim().toLowerCase();
  return `key-${createHash("sha256").update(input.apiKey).digest("hex").slice(0, 16)}`;
}
