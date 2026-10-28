import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { type Cell, type CellDirectory, cellDirectory } from "../../../../packages/core/src/cells.js";
import {
  webhookTenantState,
  type WebhookTenant,
} from "../../../../packages/core/src/db/webhook-tenants.js";
import { webhookAppId, webhookRoutingKey } from "./routing-keys.js";
import { forwardedHeader } from "./webhook-router.js";

// While customers move from the old Superlog product, the old product's
// provider apps send their requests here, and this passes them on to the old
// product (ADR 0012). LEGACY_WEBHOOK_FORWARDS names, per webhook path, the old
// apps and the old product's address for it:
// [{ "path": "/api/webhooks/slack", "appIds": ["A…"], "url": "https://…/slack/events" }]
// GitHub Apps are named by their numeric ID.
//
// - An event goes to both products, and the old product's answer is
//   returned, so the provider retries when the old product misses it. The
//   application handles a retry it already saw as a duplicate.
// - An interaction gets one answer: the application's when a workspace that is
//   not paused holds the tenant, otherwise the old product's, whose messages
//   the interaction most likely came from.

const routesSchema = z.array(z.object({
  appIds: z.array(z.string().min(1)).min(1),
  path: z.string().startsWith("/api/webhooks/"),
  url: z.url(),
}));
type LegacyRoute = z.infer<typeof routesSchema>[number];

const interactivePaths = /^\/api\/webhooks\/slack\/actions$/u;
const forwardTimeoutMs = 8_000;

// Signature and content headers the old product verifies. Load balancer
// headers stay behind.
const forwardedHeaderPattern = /^(?:content-type|user-agent|x-github-.+|x-hub-.+|x-slack-.+)$/u;

type TenantState = { active: boolean; held: boolean };
type ProviderTenant = Extract<WebhookTenant, { provider: "discord" | "github" | "linear" | "sentry" | "slack" }>;

export type LegacyWebhookForwarderDependencies = {
  askCell: (cell: Cell, tenant: ProviderTenant, token: string) => Promise<TenantState>;
  cellToken: () => string | undefined;
  directory: () => CellDirectory | null;
  forward: (url: string, init: RequestInit) => Promise<Response>;
  routes: () => LegacyRoute[];
  tenantState: (tenant: ProviderTenant) => Promise<TenantState>;
};

export function legacyWebhookRoutes(environment: NodeJS.ProcessEnv = process.env): LegacyRoute[] {
  const configured = environment.LEGACY_WEBHOOK_FORWARDS?.trim();
  if (!configured) return [];
  try {
    return routesSchema.parse(JSON.parse(configured));
  } catch {
    throw new Error("LEGACY_WEBHOOK_FORWARDS must be a JSON array of { path, appIds, url }");
  }
}

async function askCellForTenantState(cell: Cell, tenant: ProviderTenant, token: string): Promise<TenantState> {
  const response = await fetch(new URL("/api/internal/cells/webhook-tenant", cell.url), {
    body: JSON.stringify(tenant),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Cell ${cell.id} answered ${response.status}`);
  const answer = (await response.json()) as { active?: unknown; held?: unknown };
  const held = answer.held === true;
  // A cell running an older release answers only whether it holds the tenant.
  return { active: typeof answer.active === "boolean" ? answer.active : held, held };
}

const defaultDependencies: LegacyWebhookForwarderDependencies = {
  askCell: askCellForTenantState,
  cellToken: () => process.env.RESPONDER_CELL_TOKEN?.trim() || undefined,
  directory: () => cellDirectory(),
  forward: (url, init) => fetch(url, init),
  routes: () => legacyWebhookRoutes(),
  tenantState: webhookTenantState,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Where a workspace that is not paused holds the tenant: this cell, another
// cell, or none. Stops at the first active answer, and a cell that cannot be
// asked counts as not holding the tenant, so the old product answers.
async function activeHolder(
  tenant: ProviderTenant,
  dependencies: LegacyWebhookForwarderDependencies,
): Promise<"here" | Cell | null> {
  if ((await dependencies.tenantState(tenant)).active) return "here";
  const directory = dependencies.directory();
  const token = dependencies.cellToken();
  if (!directory || !token) return null;
  const others = directory.cells.filter((cell) => cell.id !== directory.current);
  if (others.length === 0) return null;
  return new Promise((resolve) => {
    let pending = others.length;
    for (const cell of others) {
      dependencies.askCell(cell, tenant, token)
        .catch(() => ({ active: false, held: false }))
        .then((answer) => {
          if (answer.active) resolve(cell);
          pending -= 1;
          if (pending === 0) resolve(null);
        });
    }
  });
}

// Hands an interaction to the cell whose active workspace holds the tenant.
// The forwarded header keeps that cell from routing it again.
async function forwardToCell(
  context: Context,
  cell: Cell,
  body: Uint8Array<ArrayBuffer>,
  currentCell: string,
  dependencies: LegacyWebhookForwarderDependencies,
): Promise<Response> {
  const headers = new Headers();
  context.req.raw.headers.forEach((value, name) => {
    if (forwardedHeaderPattern.test(name)) headers.set(name, value);
  });
  headers.set(forwardedHeader, currentCell);
  const url = new URL(context.req.url);
  const forwarded = await dependencies.forward(new URL(url.pathname + url.search, cell.url).toString(), {
    body,
    headers,
    method: "POST",
    signal: AbortSignal.timeout(forwardTimeoutMs),
  });
  return new Response(await forwarded.arrayBuffer(), {
    headers: forwarded.headers.get("content-type")
      ? { "content-type": forwarded.headers.get("content-type")! }
      : {},
    status: forwarded.status,
  });
}

async function forwardToLegacy(
  context: Context,
  route: LegacyRoute,
  body: Uint8Array<ArrayBuffer>,
  dependencies: LegacyWebhookForwarderDependencies,
): Promise<Response> {
  const headers = new Headers();
  context.req.raw.headers.forEach((value, name) => {
    if (forwardedHeaderPattern.test(name)) headers.set(name, value);
  });
  const forwarded = await dependencies.forward(route.url, {
    body,
    headers,
    method: "POST",
    signal: AbortSignal.timeout(forwardTimeoutMs),
  });
  const response = new Response(await forwarded.arrayBuffer(), {
    headers: forwarded.headers.get("content-type")
      ? { "content-type": forwarded.headers.get("content-type")! }
      : {},
    status: forwarded.status,
  });
  console.info(JSON.stringify({ event: "legacy_webhook_forwarded", path: route.path, status: forwarded.status }));
  return response;
}

export function legacyWebhookForwarder(
  dependencies: LegacyWebhookForwarderDependencies = defaultDependencies,
): MiddlewareHandler {
  return async function legacyWebhookForwarder(context, next) {
    if (context.req.method !== "POST" || context.req.header(forwardedHeader)) return next();
    const path = context.req.path.replace(/\/$/u, "");
    const candidates = dependencies.routes().filter((route) => route.path === path);
    if (candidates.length === 0) return next();

    const body = new Uint8Array(await context.req.raw.clone().arrayBuffer());
    const contentType = context.req.header("content-type");
    const appId = webhookAppId(path, contentType, body, context.req.raw.headers);
    const route = appId ? candidates.find((candidate) => candidate.appIds.includes(appId)) : undefined;
    if (!route) return next();

    if (interactivePaths.test(path)) {
      const tenant = webhookRoutingKey(path, contentType, body);
      const holder = tenant && tenant.provider !== "automation" && tenant.provider !== "integration_account"
        ? await activeHolder(tenant, dependencies).catch(() => null)
        : null;
      // The cell router keeps a tenant held here. Another cell gets the
      // interaction directly: the router routes by holding alone and could
      // pick a cell whose copy is paused.
      if (holder === "here") return next();
      if (holder) {
        try {
          return await forwardToCell(context, holder, body, dependencies.directory()!.current, dependencies);
        } catch (error) {
          console.error(JSON.stringify({ cell: holder.id, errorMessage: errorMessage(error), event: "legacy_webhook_cell_forward_failed", path }));
          return context.json({ error: "The tenant's cell is unavailable" }, 502);
        }
      }
      try {
        return await forwardToLegacy(context, route, body, dependencies);
      } catch (error) {
        console.error(JSON.stringify({ errorMessage: errorMessage(error), event: "legacy_webhook_forward_failed", path }));
        return context.json({ error: "The old product is unavailable" }, 502);
      }
    }

    const legacy = forwardToLegacy(context, route, body, dependencies).catch((error: unknown) => {
      console.error(JSON.stringify({ errorMessage: errorMessage(error), event: "legacy_webhook_forward_failed", path }));
      return null;
    });
    await next();
    const answer = await legacy;
    context.res = answer ?? new Response(JSON.stringify({ error: "The old product is unavailable" }), {
      headers: { "content-type": "application/json" },
      status: 502,
    });
  };
}
