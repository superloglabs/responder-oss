import type { Context, MiddlewareHandler } from "hono";
import { type Cell, type CellDirectory, cellDirectory } from "../../../../packages/core/src/cells.js";
import {
  hasWebhookTenant,
  type WebhookTenant,
} from "../../../../packages/core/src/db/webhook-tenants.js";
import { webhookRoutingKey } from "./routing-keys.js";

// Providers send each app's webhooks to one URL. In a multi-cell deployment
// the cell receiving them handles tenants it holds and forwards the request,
// unchanged, to every other cell that holds the tenant. Every cell verifies
// the provider's signature itself, so forwarding needs no trust in the
// forwarding cell.
export const forwardedHeader = "x-responder-cell-forwarded";

// Signature, event, and content headers the cells read. CloudFront and load
// balancer headers, including the origin verification secret, stay behind.
const forwardedHeaderPattern =
  /^(?:authorization|content-type|idempotency-key|user-agent|linear-.+|sentry-hook-.+|x-devrev-.+|x-github-.+|x-hub-.+|x-signature-.+|x-slack-.+)$/u;

// The provider uses one cell's response to these, so exactly one cell
// handles each: the receiving cell when it holds the tenant, otherwise the
// first cell that does.
const interactivePaths = /^\/api\/webhooks\/(?:discord|slack\/actions)\/?$/u;

const ownerCacheTtlMs = 5 * 60 * 1_000;
const absentCacheTtlMs = 60 * 1_000;
const ownerCachePruneSize = 1_000;
const forwardTimeoutMs = 8_000;

type OwnerCache = Map<string, { cellIds: string[]; expiresAt: number }>;

export type CellWebhookRouterDependencies = {
  askCell: (cell: Cell, tenant: WebhookTenant, token: string) => Promise<boolean>;
  cellToken: () => string | undefined;
  directory: () => CellDirectory | null;
  forward: (url: string, init: RequestInit) => Promise<Response>;
  hasTenant: (tenant: WebhookTenant) => Promise<boolean>;
  now: () => number;
};

export async function askCellForTenant(
  cell: Cell,
  tenant: WebhookTenant,
  token: string,
): Promise<boolean> {
  const response = await fetch(new URL("/api/internal/cells/webhook-tenant", cell.url), {
    body: JSON.stringify(tenant),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Cell ${cell.id} answered ${response.status}`);
  const answer = (await response.json()) as { held?: unknown };
  return answer.held === true;
}

const defaultDependencies: CellWebhookRouterDependencies = {
  askCell: askCellForTenant,
  cellToken: () => process.env.RESPONDER_CELL_TOKEN?.trim() || undefined,
  directory: () => cellDirectory(),
  forward: (url, init) => fetch(url, init),
  hasTenant: hasWebhookTenant,
  now: () => Date.now(),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The other cells that hold the tenant. Throws when no holder was found but
// some cell could not be asked, so the delivery fails and the provider retries.
async function otherOwners(
  directory: CellDirectory,
  tenant: WebhookTenant,
  token: string,
  dependencies: CellWebhookRouterDependencies,
  cache: OwnerCache,
): Promise<Cell[]> {
  const others = directory.cells.filter((cell) => cell.id !== directory.current);
  const cacheKey = `${tenant.provider}:${tenant.key}`;
  const now = dependencies.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return others.filter((cell) => cached.cellIds.includes(cell.id));
  }

  const owners: Cell[] = [];
  const failures: string[] = [];
  await Promise.all(
    others.map(async (cell) => {
      try {
        if (await dependencies.askCell(cell, tenant, token)) owners.push(cell);
      } catch (error) {
        failures.push(cell.id);
        console.error(
          JSON.stringify({
            cell: cell.id,
            errorMessage: errorMessage(error),
            event: "cell_webhook_tenant_lookup_failed",
            provider: tenant.provider,
          }),
        );
      }
    }),
  );
  const ordered = others.filter((cell) => owners.includes(cell));
  if (failures.length === 0) {
    if (cache.size >= ownerCachePruneSize) {
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
    }
    cache.set(cacheKey, {
      cellIds: ordered.map((cell) => cell.id),
      expiresAt: now + (ordered.length ? ownerCacheTtlMs : absentCacheTtlMs),
    });
  } else if (ordered.length === 0) {
    throw new Error(`Could not ask cells ${failures.join(", ")}`);
  }
  return ordered;
}

async function forwardTo(
  context: Context,
  cell: Cell,
  body: Uint8Array<ArrayBuffer>,
  currentCell: string,
  tenant: WebhookTenant,
  dependencies: CellWebhookRouterDependencies,
): Promise<Response> {
  const headers = new Headers();
  context.req.raw.headers.forEach((value, name) => {
    if (forwardedHeaderPattern.test(name)) headers.set(name, value);
  });
  headers.set(forwardedHeader, currentCell);
  const url = new URL(context.req.url);
  const forwarded = await dependencies.forward(
    new URL(url.pathname + url.search, cell.url).toString(),
    { body, headers, method: "POST", signal: AbortSignal.timeout(forwardTimeoutMs) },
  );
  console.info(
    JSON.stringify({
      cell: cell.id,
      event: "cell_webhook_forwarded",
      provider: tenant.provider,
      status: forwarded.status,
    }),
  );
  return forwarded;
}

export function cellWebhookRouter(
  dependencies: CellWebhookRouterDependencies = defaultDependencies,
  cache: OwnerCache = new Map(),
): MiddlewareHandler {
  return async function cellWebhookRouter(context, next) {
    const directory = dependencies.directory();
    const token = dependencies.cellToken();
    if (
      !directory ||
      !token ||
      directory.cells.length < 2 ||
      context.req.method !== "POST" ||
      context.req.header(forwardedHeader)
    ) {
      return next();
    }

    const body = new Uint8Array(await context.req.raw.clone().arrayBuffer());
    const tenant = webhookRoutingKey(context.req.path, context.req.header("content-type"), body);
    if (!tenant) return next();
    const interactive = interactivePaths.test(context.req.path);

    // Copies to other holders never delay or change this cell's response.
    const copyTo = (cells: Cell[]) => {
      for (const cell of cells) {
        void forwardTo(context, cell, body, directory.current, tenant, dependencies).catch(
          (error: unknown) => {
            console.error(
              JSON.stringify({
                cell: cell.id,
                errorMessage: errorMessage(error),
                event: "cell_webhook_copy_failed",
                provider: tenant.provider,
              }),
            );
          },
        );
      }
    };

    let heldHere: boolean;
    try {
      heldHere = await dependencies.hasTenant(tenant);
    } catch (error) {
      console.error(
        JSON.stringify({
          errorMessage: errorMessage(error),
          event: "cell_webhook_routing_failed",
          provider: tenant.provider,
        }),
      );
      return next();
    }

    if (heldHere) {
      if (!interactive) {
        void otherOwners(directory, tenant, token, dependencies, cache)
          .then(copyTo)
          .catch(() => undefined);
      }
      return next();
    }

    let owners: Cell[];
    try {
      owners = await otherOwners(directory, tenant, token, dependencies, cache);
    } catch {
      return context.json({ error: "The tenant's cell could not be found" }, 502);
    }
    const [owner, ...others] = owners;
    if (!owner) return next();
    if (!interactive) copyTo(others);

    let forwarded: Response;
    try {
      forwarded = await forwardTo(context, owner, body, directory.current, tenant, dependencies);
    } catch (error) {
      // A failed delivery lets the provider retry it.
      console.error(
        JSON.stringify({
          cell: owner.id,
          errorMessage: errorMessage(error),
          event: "cell_webhook_forward_failed",
          provider: tenant.provider,
        }),
      );
      return context.json({ error: "The tenant's cell is unavailable" }, 502);
    }
    return new Response(await forwarded.arrayBuffer(), {
      headers: forwarded.headers.get("content-type")
        ? { "content-type": forwarded.headers.get("content-type")! }
        : {},
      status: forwarded.status,
    });
  };
}
