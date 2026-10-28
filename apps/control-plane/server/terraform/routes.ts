import { Hono } from "hono";
import { z } from "zod";
import { getActiveTenant } from "../tenant.js";
import { buildTerraformExport } from "./export.js";

// Terraform export for the app's "Copy as Terraform" actions.
const ids = z.array(z.uuid()).max(500).optional();
const selectionSchema = z.object({ alertIds: ids, dashboardIds: ids, syntheticCheckIds: ids });

export const terraformRoutes = new Hono().post("/export", async (context) => {
  const tenant = await getActiveTenant(context.req.raw.headers);
  if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
  const selection = selectionSchema.safeParse(await context.req.json().catch(() => null));
  if (!selection.success) return context.json({ error: "Invalid selection" }, 400);
  const result = await buildTerraformExport(tenant.organizationId, selection.data);
  return result.ok ? context.json({ hcl: result.hcl }) : context.json({ error: result.error }, 404);
});
