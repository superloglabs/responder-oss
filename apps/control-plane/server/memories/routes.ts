import { Hono } from "hono";
import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  deleteWorkspaceMemory,
  getWorkspaceMemory,
  importWorkspaceMemories,
  listWorkspaceMemories,
  updateWorkspaceMemory,
  WorkspaceMemoryError,
} from "../../../../packages/core/src/db/workspace-memories.js";
import { memoryInputSchema } from "../../../../packages/core/src/memories/config.js";
import { getActiveTenant } from "../tenant.js";

// Memories reach automation runs and tag mode, so they share the automations
// capability with skills.
async function getMemoryTenant(headers: Headers) {
  const tenant = await getActiveTenant(headers);
  if (tenant.ok === false) return tenant;
  if (!(await organizationHasCapability(tenant.organizationId, "automations"))) {
    return { ok: false as const, error: "Not found", status: 404 as const };
  }
  return tenant;
}

function memoryError(error: unknown) {
  if (!(error instanceof WorkspaceMemoryError)) throw error;
  return {
    body: { code: error.code, error: error.message },
    status: error.code === "credential" ? 422 as const : 409 as const,
  };
}

async function parseMemory(request: Request) {
  return memoryInputSchema.safeParse(await request.json().catch(() => null));
}

export const memoryRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getMemoryTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    return context.json({ memories: await listWorkspaceMemories(tenant.organizationId) });
  })
  .get("/:memoryId", async (context) => {
    const tenant = await getMemoryTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const memoryId = context.req.param("memoryId");
    if (!z.uuid().safeParse(memoryId).success) return context.json({ error: "Memory not found" }, 404);
    const memory = await getWorkspaceMemory(tenant.organizationId, memoryId);
    return memory
      ? context.json({ memory })
      : context.json({ error: "Memory not found" }, 404);
  })
  .post("/", async (context) => {
    const tenant = await getMemoryTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const parsed = await parseMemory(context.req.raw);
    if (!parsed.success) {
      return context.json({ error: "Invalid memory", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await importWorkspaceMemories({
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
        memories: [parsed.data],
      });
      const created = result.created[0];
      return created
        ? context.json({ memory: { id: created.id } }, 201)
        : context.json({
            code: "name_conflict",
            error: `A memory named ${parsed.data.name} already exists in this workspace`,
          }, 409);
    } catch (error) {
      const failure = memoryError(error);
      return context.json(failure.body, failure.status);
    }
  })
  .put("/:memoryId", async (context) => {
    const tenant = await getMemoryTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const memoryId = context.req.param("memoryId");
    if (!z.uuid().safeParse(memoryId).success) return context.json({ error: "Memory not found" }, 404);
    const parsed = await parseMemory(context.req.raw);
    if (!parsed.success) {
      return context.json({ error: "Invalid memory", issues: parsed.error.issues }, 400);
    }
    try {
      const updated = await updateWorkspaceMemory({
        organizationId: tenant.organizationId,
        memoryId,
        userId: tenant.user.id,
        memory: parsed.data,
      });
      return updated
        ? context.json({ memory: { id: memoryId } })
        : context.json({ error: "Memory not found" }, 404);
    } catch (error) {
      const failure = memoryError(error);
      return context.json(failure.body, failure.status);
    }
  })
  .delete("/:memoryId", async (context) => {
    const tenant = await getMemoryTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const memoryId = context.req.param("memoryId");
    if (!z.uuid().safeParse(memoryId).success) return context.json({ error: "Memory not found" }, 404);
    const deleted = await deleteWorkspaceMemory({
      organizationId: tenant.organizationId,
      memoryId,
    });
    return deleted
      ? context.json({ deleted: true })
      : context.json({ error: "Memory not found" }, 404);
  });
