import type { WebhookTenant } from "../../../../packages/core/src/db/webhook-tenants.js";

// Identifies the tenant a provider webhook belongs to, so a multi-cell
// deployment can send it to the cell that holds that tenant. A null key means
// the receiving cell handles the request itself: provider verification
// handshakes, unknown paths, and unreadable bodies.
export type WebhookRoutingKey = WebhookTenant;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const perAccountPath = /^\/api\/webhooks\/(?:dash0|axiom|devrev|signoz|honeycomb)\/([^/]+)\/?$/u;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function parseJson(body: Uint8Array): JsonObject | null {
  try {
    return object(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return null;
  }
}

function key(
  provider: Exclude<WebhookTenant["provider"], "integration_account">,
  value: unknown,
): WebhookRoutingKey | null {
  const routingKey = text(value);
  return routingKey ? { provider, key: routingKey } : null;
}

export function webhookRoutingKey(
  path: string,
  contentType: string | undefined,
  body: Uint8Array,
): WebhookRoutingKey | null {
  const perAccount = perAccountPath.exec(path)?.[1];
  if (perAccount !== undefined) {
    return uuidPattern.test(perAccount) ? { provider: "integration_account", key: perAccount } : null;
  }

  const route = path.replace(/\/$/u, "");
  if (route === "/api/webhooks/slack/actions") {
    if (!contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) return null;
    const payload = new URLSearchParams(new TextDecoder().decode(body)).get("payload");
    if (!payload) return null;
    const interaction = parseJson(new TextEncoder().encode(payload));
    return key("slack", object(interaction?.team)?.id ?? object(interaction?.user)?.team_id);
  }

  const event = parseJson(body);
  if (!event) return null;
  switch (route) {
    case "/api/webhooks/slack": {
      if (event.type === "url_verification") return null;
      const authorizations = Array.isArray(event.authorizations) ? event.authorizations : [];
      return key("slack", event.team_id ?? object(authorizations[0])?.team_id);
    }
    case "/api/webhooks/discord":
      return event.type === 1 ? null : key("discord", event.guild_id);
    case "/api/webhooks/linear":
      return key("linear", event.organizationId);
    case "/api/webhooks/sentry":
      return key("sentry", object(event.installation)?.uuid);
    case "/api/webhooks/github":
      return key("github", object(event.installation)?.id);
    default:
      return null;
  }
}
