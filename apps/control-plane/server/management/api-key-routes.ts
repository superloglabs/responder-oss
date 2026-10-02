import { Hono } from "hono";
import { z } from "zod";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../../../../packages/core/src/db/api-keys.js";
import { captureAnalyticsEvent } from "../../../../packages/core/src/analytics.js";
import { getActiveTenant } from "../tenant.js";

const apiKeyInputSchema = z.object({
  name: z.string().trim().min(1, "Name the key").max(120),
});

function managesAllKeys(role: string): boolean {
  return role.split(",").some((part) => part === "admin" || part === "owner");
}

// Session routes for Settings → API keys. The keys themselves authenticate
// only the management API and MCP server.
export const apiKeyRoutes = new Hono()
  .use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  })
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const apiKeys = await listApiKeys(tenant.organizationId);
    const all = managesAllKeys(tenant.role);
    return context.json({
      apiKeys: apiKeys.map((key) => ({
        ...key,
        canRevoke: all || key.createdBy.id === tenant.user.id,
      })),
    });
  })
  .post("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const parsed = apiKeyInputSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid API key", issues: parsed.error.issues },
        400,
      );
    }
    const created = await createApiKey({
      name: parsed.data.name,
      organizationId: tenant.organizationId,
      user: tenant.user,
    });
    await captureAnalyticsEvent({
      distinctId: tenant.user.id,
      event: "api key created",
      organizationId: tenant.organizationId,
      properties: { api_key_id: created.key.id },
    }).catch(() => undefined);
    return context.json({ apiKey: { ...created.key, canRevoke: true }, token: created.token }, 201);
  })
  .delete("/:apiKeyId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const apiKeyId = context.req.param("apiKeyId");
    if (!z.uuid().safeParse(apiKeyId).success) {
      return context.json({ error: "API key not found" }, 404);
    }
    const revoked = await revokeApiKey({
      apiKeyId,
      organizationId: tenant.organizationId,
      role: tenant.role,
      userId: tenant.user.id,
    });
    return revoked
      ? context.json({ revoked: true })
      : context.json({ error: "API key not found" }, 404);
  });
