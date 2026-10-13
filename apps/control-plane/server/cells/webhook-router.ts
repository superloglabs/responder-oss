import type { MiddlewareHandler } from "hono";
import { type Cell, type CellDirectory, cellDirectory } from "../../../../packages/core/src/cells.js";
import {
  hasWebhookTenant,
  type WebhookTenant,
} from "../../../../packages/core/src/db/webhook-tenants.js";
import { webhookRoutingKey } from "./routing-keys.js";

// Providers send each app's webhooks to one URL. In a multi-cell deployment
// the cell receiving them handles tenants it holds and forwards the rest,
// unchanged, to the cell that holds them. Every cell verifies the provider's
// signature itself, so forwarding needs no trust in the forwarding cell.
export const forwardedHeader = "x-responder-cell-forwarded";

// Signature, event, and content headers the cells read. CloudFront and load
// balancer headers, including the origin verification secret, stay behind.
const forwardedHeaderPattern =
  /^(?:authorization|content-type|user-agent|linear-.+|sentry-hook-.+|x-devrev-.+|x-github-.+|x-hub-.+|x-signature-.+|x-slack-.+)$/u;

const ownerCacheTtlMs = 5 * 60 * 1_000;
const absentCacheTtlMs = 60 * 1_000;
const forwardTimeoutMs = 8_000;

type OwnerCache = Map<string, { cellId: string | null; expiresAt: number }>;

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

async function owningCell(
  directory: CellDirectory,
  tenant: WebhookTenant,
  token: string,
  dependencies: CellWebhookRouterDependencies,
  cache: OwnerCache,
): Promise<Cell | null> {
  const cacheKey = `${tenant.provider}:${tenant.key}`;
  const cached = cache.get(cacheKey);
  const others = directory.cells.filter((cell) => cell.id !== directory.current);
  if (cached && cached.expiresAt > dependencies.now()) {
    return others.find((cell) => cell.id === cached.cellId) ?? null;
  }

  for (const cell of others) {
    if (await dependencies.askCell(cell, tenant, token)) {
      cache.set(cacheKey, { cellId: cell.id, expiresAt: dependencies.now() + ownerCacheTtlMs });
      return cell;
    }
  }
  cache.set(cacheKey, { cellId: null, expiresAt: dependencies.now() + absentCacheTtlMs });
  return null;
}

export function cellWebhookRouter(
  dependencies: CellWebhookRouterDependencies = defaultDependencies,
  cache: OwnerCache = new Map(),
): MiddlewareHandler {
  return async (context, next) => {
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

    let owner: Cell | null;
    try {
      if (await dependencies.hasTenant(tenant)) return next();
      owner = await owningCell(directory, tenant, token, dependencies, cache);
    } catch (error) {
      // The receiving cell handles what it cannot route, as before cells.
      console.error(
        JSON.stringify({
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "cell_webhook_routing_failed",
          provider: tenant.provider,
        }),
      );
      return next();
    }
    if (!owner) return next();

    const headers = new Headers();
    context.req.raw.headers.forEach((value, name) => {
      if (forwardedHeaderPattern.test(name)) headers.set(name, value);
    });
    headers.set(forwardedHeader, directory.current);
    const url = new URL(context.req.url);
    let forwarded: Response;
    try {
      forwarded = await dependencies.forward(
        new URL(url.pathname + url.search, owner.url).toString(),
        { body, headers, method: "POST", signal: AbortSignal.timeout(forwardTimeoutMs) },
      );
    } catch (error) {
      // A failed delivery lets the provider retry it.
      console.error(
        JSON.stringify({
          cell: owner.id,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "cell_webhook_forward_failed",
          provider: tenant.provider,
        }),
      );
      return context.json({ error: "The tenant's cell is unavailable" }, 502);
    }
    console.info(
      JSON.stringify({
        cell: owner.id,
        event: "cell_webhook_forwarded",
        provider: tenant.provider,
        status: forwarded.status,
      }),
    );
    return new Response(await forwarded.arrayBuffer(), {
      headers: forwarded.headers.get("content-type")
        ? { "content-type": forwarded.headers.get("content-type")! }
        : {},
      status: forwarded.status,
    });
  };
}
