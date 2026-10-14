import { Hono } from "hono";
import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  createTelemetryIngestKey,
  listTelemetryIngestKeys,
  revokeTelemetryIngestKey,
} from "../../../../packages/core/src/db/telemetry-ingest-keys.js";
import { telemetryCollectorUrl } from "../../../../packages/core/src/telemetry/client.js";
import { getActiveTenant } from "../tenant.js";

// Keys applications send telemetry with. Available with the telemetry
// capability in a cell that accepts telemetry.
export type IngestKeyRouteDependencies = {
  collectorUrl: () => string | null;
  createKey: typeof createTelemetryIngestKey;
  hasTelemetry: (organizationId: string) => Promise<boolean>;
  listKeys: typeof listTelemetryIngestKeys;
  revokeKey: typeof revokeTelemetryIngestKey;
  tenant: (
    headers: Headers,
  ) => Promise<
    | { ok: true; organizationId: string; role: string; user: { id: string } }
    | { error: string; ok: false; status: 401 | 403 | 409 }
  >;
};

const defaultDependencies: IngestKeyRouteDependencies = {
  collectorUrl: telemetryCollectorUrl,
  createKey: createTelemetryIngestKey,
  hasTelemetry: (organizationId) => organizationHasCapability(organizationId, "telemetry"),
  listKeys: listTelemetryIngestKeys,
  revokeKey: revokeTelemetryIngestKey,
  tenant: getActiveTenant,
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  projectId: z.uuid().optional(),
});

export function createIngestKeyRoutes(dependencies: IngestKeyRouteDependencies = defaultDependencies) {
  async function access(headers: Headers): Promise<
    | { ok: true; organizationId: string; role: string; userId: string }
    | { error: string; ok: false; status: 401 | 403 | 404 | 409 }
  > {
    const tenant = await dependencies.tenant(headers);
    if (tenant.ok === false) return { error: tenant.error, ok: false, status: tenant.status };
    if (!dependencies.collectorUrl() || !(await dependencies.hasTelemetry(tenant.organizationId))) {
      return { error: "Sending telemetry is not available", ok: false, status: 404 };
    }
    return { ok: true, organizationId: tenant.organizationId, role: tenant.role, userId: tenant.user.id };
  }

  return new Hono()
    .get("/", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      return context.json({ keys: await dependencies.listKeys(granted.organizationId) });
    })
    .post("/", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = createSchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: "Name the key" }, 400);
      const created = await dependencies.createKey({
        createdBy: granted.userId,
        name: body.data.name,
        organizationId: granted.organizationId,
        ...(body.data.projectId ? { projectId: body.data.projectId } : {}),
      });
      return created ? context.json(created, 201) : context.json({ error: "Telemetry project not found" }, 404);
    })
    .delete("/:keyId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const keyId = z.uuid().safeParse(context.req.param("keyId"));
      if (!keyId.success) return context.json({ error: "Key not found" }, 404);
      const result = await dependencies.revokeKey({
        keyId: keyId.data,
        organizationId: granted.organizationId,
        role: granted.role,
        userId: granted.userId,
      });
      if (result === "revoked") return context.body(null, 204);
      return result === "forbidden"
        ? context.json({ error: "Only the key's creator or an admin can revoke it" }, 403)
        : context.json({ error: "Key not found" }, 404);
    });
}
