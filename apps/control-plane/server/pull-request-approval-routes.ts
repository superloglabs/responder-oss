import { Hono } from "hono";
import { z } from "zod";
import {
  pullRequestApprovalRequired,
  savePullRequestApprovalRequired,
} from "../../../packages/core/src/db/pull-request-approval.js";
import { getActiveTenant } from "./tenant.js";

const defaults = {
  tenant: getActiveTenant,
  get: (organizationId: string) => pullRequestApprovalRequired(organizationId),
  save: savePullRequestApprovalRequired,
};

function isAdmin(role: string): boolean {
  return role.split(",").some((value) => ["owner", "admin"].includes(value.trim()));
}

// Whether pull requests from runs that an alert, a webhook request, or a
// channel message started wait for a workspace member to approve them.
// Members can read it; administrators change it.
export function createPullRequestApprovalRoutes(deps = defaults) {
  return new Hono().get("/", async (context) => {
    const tenant = await deps.tenant(context.req.raw.headers);
    if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
    const requireApproval = await deps.get(tenant.organizationId);
    return context.json({ canEdit: isAdmin(tenant.role), requireApproval }, 200, { "cache-control": "no-store" });
  }).put("/", async (context) => {
    const tenant = await deps.tenant(context.req.raw.headers);
    if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
    if (!isAdmin(tenant.role)) return context.json({ error: "Workspace administrator access required" }, 403);
    const parsed = z.object({ requireApproval: z.boolean() }).safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "Choose on or off" }, 400);
    await deps.save(tenant.organizationId, parsed.data.requireApproval);
    return context.json({ canEdit: true, requireApproval: await deps.get(tenant.organizationId) });
  });
}
