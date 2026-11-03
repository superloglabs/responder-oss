import { Hono } from "hono";
import {
  getSandboxNetworkSettings,
  saveSandboxNetworkSettings,
} from "../../../../packages/core/src/db/sandbox-network.js";
import { sandboxNetworkSettingsSchema } from "../../../../packages/core/src/sandbox-network.js";
import { getActiveTenant } from "../tenant.js";

// Members can see what a workspace's sandboxes reach. Only owners and admins
// change it, because the list decides where an agent can send data.

const defaults = {
  applicationUrl: () =>
    process.env.RESPONDER_PUBLIC_URL ?? process.env.RESPONDER_APP_URL ?? process.env.BETTER_AUTH_URL,
  get: getSandboxNetworkSettings,
  save: saveSandboxNetworkSettings,
  tenant: getActiveTenant,
};

function isWorkspaceAdmin(role: string): boolean {
  return role.split(",").some((value) => ["owner", "admin"].includes(value.trim()));
}

export function createSandboxNetworkRoutes(deps = defaults) {
  async function presented(organizationId: string, role: string) {
    const applicationUrl = deps.applicationUrl();
    return {
      // Reached by every sandbox: the model broker and context servers.
      alwaysAllowed: applicationUrl ? [new URL(applicationUrl).hostname] : [],
      canEdit: isWorkspaceAdmin(role),
      settings: await deps.get(organizationId),
    };
  }

  return new Hono()
    .get("/", async (context) => {
      const tenant = await deps.tenant(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      return context.json(
        await presented(tenant.organizationId, tenant.role),
        200,
        { "cache-control": "no-store" },
      );
    })
    .put("/", async (context) => {
      const tenant = await deps.tenant(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      if (!isWorkspaceAdmin(tenant.role)) {
        return context.json({ error: "Workspace administrator access required" }, 403);
      }
      const parsed = sandboxNetworkSettingsSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return context.json(
          { error: parsed.error.issues[0]?.message ?? "Invalid sandbox network settings" },
          400,
        );
      }
      await deps.save(tenant.organizationId, parsed.data, tenant.user.id);
      return context.json(await presented(tenant.organizationId, tenant.role));
    });
}
