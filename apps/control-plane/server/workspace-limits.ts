import { HTTPException } from "hono/http-exception";
import type { TelemetryClient } from "../../../packages/core/src/telemetry/client.js";

// Limits on how much of this process's shared capacity one workspace can hold
// at once: telemetry store connections, management operations, and ingest
// requests. They are counted in this process, so each API task enforces them
// on its own.

const busyMessage = "This workspace has too many requests in progress. Try again shortly.";

export class WorkspaceBusyError extends HTTPException {
  constructor(readonly retryAfterSeconds: number) {
    super(429, {
      message: busyMessage,
      res: Response.json(
        { code: "workspace_busy", error: busyMessage, retryAfterSeconds },
        { headers: { "retry-after": String(retryAfterSeconds) }, status: 429 },
      ),
    });
    this.name = "WorkspaceBusyError";
  }
}

type Waiter = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null };

// Runs at most `limit` tasks per key at once. Further tasks wait in order for
// up to `waitMs`, and at most `maxWaiting` of them per key; past either bound
// they fail with WorkspaceBusyError.
export function createConcurrencyLimiter({ limit, maxWaiting, waitMs }: { limit: number; maxWaiting: number; waitMs: number }) {
  const keys = new Map<string, { running: number; waiting: Waiter[] }>();
  const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));

  function state(key: string) {
    let current = keys.get(key);
    if (!current) {
      current = { running: 0, waiting: [] };
      keys.set(key, current);
    }
    return current;
  }

  function release(key: string): void {
    const current = keys.get(key);
    if (!current) return;
    const next = current.waiting.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
      return;
    }
    current.running -= 1;
    if (current.running === 0) keys.delete(key);
  }

  function acquire(key: string): Promise<void> {
    const current = state(key);
    if (current.running < limit) {
      current.running += 1;
      return Promise.resolve();
    }
    if (current.waiting.length >= maxWaiting) return Promise.reject(new WorkspaceBusyError(retryAfterSeconds));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { reject, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = current.waiting.indexOf(waiter);
        if (index >= 0) current.waiting.splice(index, 1);
        reject(new WorkspaceBusyError(retryAfterSeconds));
      }, waitMs);
      current.waiting.push(waiter);
    });
  }

  return {
    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
      await acquire(key);
      try {
        return await task();
      } finally {
        release(key);
      }
    },
    // A slot without waiting: its release function, or null when the key
    // has none free.
    tryAcquire(key: string): (() => void) | null {
      const current = state(key);
      if (current.running >= limit) return null;
      current.running += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release(key);
      };
    },
  };
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// How many telemetry queries one workspace runs at once in this process: half
// of the store connections, so another workspace always finds one free.
export function workspaceQueryConcurrency(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = positiveInteger(environment.TELEMETRY_WORKSPACE_QUERY_CONCURRENCY);
  if (configured) return configured;
  // The ClickHouse client opens 10 connections unless told otherwise.
  const connections = positiveInteger(environment.TELEMETRY_CLICKHOUSE_MAX_CONNECTIONS) ?? 10;
  return Math.max(1, Math.floor(connections / 2));
}

// The store's request timeout: a query that cannot start within it fails.
const telemetryQueries = createConcurrencyLimiter({ limit: workspaceQueryConcurrency(), maxWaiting: 50, waitMs: 20_000 });

// The workspace's view of the telemetry store, whose queries take one of the
// workspace's slots while they run.
export function limitedTelemetryClient(
  client: TelemetryClient,
  organizationId: string,
  limiter = telemetryQueries,
): TelemetryClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return (params: Parameters<TelemetryClient["query"]>[0]) =>
          limiter.run(organizationId, () => target.query(params));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Management API and MCP operations one workspace runs at once in this
// process. One MCP request can carry many tool calls.
export const workspaceOperations = createConcurrencyLimiter({ limit: 10, maxWaiting: 100, waitMs: 30_000 });

// Ingest requests one workspace has in flight in this process. Exporters retry
// a refused batch.
export const workspaceIngestRequests = createConcurrencyLimiter({ limit: 16, maxWaiting: 0, waitMs: 0 });
