import { Hono } from "hono";
import { z } from "zod";
import { getHandoffTargets, saveHandoffTargets } from "../../../packages/core/src/db/handoff-settings.js";
import { handoffTargetsSchema } from "../../../packages/core/src/ide-handoff.js";
import { getActiveTenant } from "./tenant.js";

const defaults = { tenant: getActiveTenant, get: getHandoffTargets, save: saveHandoffTargets };

function isAdmin(role: string): boolean {
  return role.split(",").some((value) => ["owner", "admin"].includes(value.trim()));
}

// The buttons the workspace's Slack notifications show for handing the
// context to a coding agent. Members can read them; admins change them.
export function createHandoffSettingsRoutes(deps = defaults) {
  return new Hono().get("/", async (context) => {
    const tenant = await deps.tenant(context.req.raw.headers);
    if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
    const targets = await deps.get(tenant.organizationId);
    return context.json({ canEdit: isAdmin(tenant.role), targets }, 200, { "cache-control": "no-store" });
  }).put("/", async (context) => {
    const tenant = await deps.tenant(context.req.raw.headers);
    if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
    if (!isAdmin(tenant.role)) return context.json({ error: "Workspace administrator access required" }, 403);
    const parsed = z.object({ targets: handoffTargetsSchema }).safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "Choose from the listed buttons" }, 400);
    await deps.save(tenant.organizationId, parsed.data.targets);
    return context.json({ canEdit: true, targets: await deps.get(tenant.organizationId) });
  });
}
