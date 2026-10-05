import { Hono } from "hono";
import { z } from "zod";
import { skillInputSchema } from "../../../../packages/core/src/skills/config.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  createWorkspaceSkill,
  deleteWorkspaceSkill,
  getWorkspaceSkill,
  listWorkspaceSkills,
  updateWorkspaceSkill,
  WorkspaceSkillError,
} from "../../../../packages/core/src/db/workspace-skills.js";
import { getActiveTenant } from "../tenant.js";

// Skills extend automations, so they share the automations capability.
async function getSkillTenant(headers: Headers) {
  const tenant = await getActiveTenant(headers);
  if (tenant.ok === false) return tenant;
  if (!(await organizationHasCapability(tenant.organizationId, "automations"))) {
    return { ok: false as const, error: "Not found", status: 404 as const };
  }
  return tenant;
}

function skillError(error: unknown) {
  if (!(error instanceof WorkspaceSkillError)) throw error;
  return {
    body: { code: error.code, error: error.message },
    status: error.code === "secret_not_found" ? 400 as const : 409 as const,
  };
}

async function parseSkill(request: Request) {
  return skillInputSchema.safeParse(await request.json().catch(() => null));
}

export const skillRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getSkillTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    return context.json({ skills: await listWorkspaceSkills(tenant.organizationId) });
  })
  .get("/:skillId", async (context) => {
    const tenant = await getSkillTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const skillId = context.req.param("skillId");
    if (!z.uuid().safeParse(skillId).success) return context.json({ error: "Skill not found" }, 404);
    const skill = await getWorkspaceSkill(tenant.organizationId, skillId);
    return skill
      ? context.json({ skill })
      : context.json({ error: "Skill not found" }, 404);
  })
  .post("/", async (context) => {
    const tenant = await getSkillTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const parsed = await parseSkill(context.req.raw);
    if (!parsed.success) {
      return context.json({ error: "Invalid skill", issues: parsed.error.issues }, 400);
    }
    try {
      const skill = await createWorkspaceSkill({
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
        skill: parsed.data,
      });
      return context.json({ skill }, 201);
    } catch (error) {
      const failure = skillError(error);
      return context.json(failure.body, failure.status);
    }
  })
  .put("/:skillId", async (context) => {
    const tenant = await getSkillTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const skillId = context.req.param("skillId");
    if (!z.uuid().safeParse(skillId).success) return context.json({ error: "Skill not found" }, 404);
    const parsed = await parseSkill(context.req.raw);
    if (!parsed.success) {
      return context.json({ error: "Invalid skill", issues: parsed.error.issues }, 400);
    }
    try {
      const updated = await updateWorkspaceSkill({
        organizationId: tenant.organizationId,
        skillId,
        skill: parsed.data,
      });
      return updated
        ? context.json({ skill: { id: skillId } })
        : context.json({ error: "Skill not found" }, 404);
    } catch (error) {
      const failure = skillError(error);
      return context.json(failure.body, failure.status);
    }
  })
  .delete("/:skillId", async (context) => {
    const tenant = await getSkillTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const skillId = context.req.param("skillId");
    if (!z.uuid().safeParse(skillId).success) return context.json({ error: "Skill not found" }, 404);
    try {
      const deleted = await deleteWorkspaceSkill({
        organizationId: tenant.organizationId,
        skillId,
      });
      return deleted
        ? context.json({ deleted: true })
        : context.json({ error: "Skill not found" }, 404);
    } catch (error) {
      const failure = skillError(error);
      return context.json(failure.body, failure.status);
    }
  });
