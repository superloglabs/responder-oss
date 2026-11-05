import { Hono } from "hono";
import { z } from "zod";
import { ClaudeRoutineFireError, claudeRoutineTriggerId } from "../../../../packages/core/src/claude-routines.js";
import {
  createClaudeRoutine,
  deleteClaudeRoutine,
  listClaudeRoutines,
  startClaudeRoutine,
} from "../../../../packages/core/src/db/claude-routines.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { getActiveTenant } from "../tenant.js";

// Claude Code routines that alerts and error notifications start. Members
// can list them to choose one; owners and admins add, remove, and test them,
// since each start uses the routine owner's Claude plan.
export type ClaudeRoutineRouteDependencies = {
  create: typeof createClaudeRoutine;
  delete: typeof deleteClaudeRoutine;
  hasTelemetry: (organizationId: string) => Promise<boolean>;
  list: typeof listClaudeRoutines;
  start: (input: Parameters<typeof startClaudeRoutine>[0]) => ReturnType<typeof startClaudeRoutine>;
  tenant: (
    headers: Headers,
  ) => Promise<
    | { ok: true; organizationId: string; role: string; user: { id: string } }
    | { error: string; ok: false; status: 401 | 403 | 409 }
  >;
};

const defaultDependencies: ClaudeRoutineRouteDependencies = {
  create: createClaudeRoutine,
  delete: deleteClaudeRoutine,
  hasTelemetry: (organizationId) => organizationHasCapability(organizationId, "telemetry"),
  list: listClaudeRoutines,
  start: (input) => startClaudeRoutine(input),
  tenant: getActiveTenant,
};

const createSchema = z.object({
  fireUrl: z.string().trim().max(500),
  name: z.string().trim().min(1, "Name the routine").max(120),
  token: z.string().trim().min(1, "Paste the routine's token").max(1_000),
});

const idSchema = z.uuid();

const testText = [
  "This is a test from Superlog. Nothing is wrong.",
  "",
  "Superlog starts this routine when an alert fires or an error is new or happens again, with the details as this text.",
].join("\n");

export function createClaudeRoutineRoutes(dependencies: ClaudeRoutineRouteDependencies = defaultDependencies) {
  async function access(headers: Headers, admin: boolean): Promise<
    | { ok: true; organizationId: string; userId: string }
    | { error: string; ok: false; status: 401 | 403 | 404 | 409 }
  > {
    const tenant = await dependencies.tenant(headers);
    if (tenant.ok === false) return { error: tenant.error, ok: false, status: tenant.status };
    if (!(await dependencies.hasTelemetry(tenant.organizationId))) {
      return { error: "Claude routines are not available", ok: false, status: 404 };
    }
    if (admin && !tenant.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
      return { error: "Workspace administrator access required", ok: false, status: 403 };
    }
    return { ok: true, organizationId: tenant.organizationId, userId: tenant.user.id };
  }

  const notFound = { error: "Routine not found" };

  return new Hono()
    .get("/", async (context) => {
      const granted = await access(context.req.raw.headers, false);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      return context.json({ routines: await dependencies.list(granted.organizationId) });
    })
    .post("/", async (context) => {
      const granted = await access(context.req.raw.headers, true);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = createSchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: body.error.issues[0]?.message ?? "Invalid routine" }, 400);
      const triggerId = claudeRoutineTriggerId(body.data.fireUrl);
      if (!triggerId) {
        return context.json({ error: "Paste the routine's Fire URL, such as https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" }, 400);
      }
      const routine = await dependencies.create(granted.organizationId, {
        createdBy: granted.userId,
        name: body.data.name,
        token: body.data.token,
        triggerId,
      });
      return context.json({ routine }, 201);
    })
    .post("/:routineId/test", async (context) => {
      const granted = await access(context.req.raw.headers, true);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const routineId = idSchema.safeParse(context.req.param("routineId"));
      if (!routineId.success) return context.json(notFound, 404);
      try {
        const started = await dependencies.start({ organizationId: granted.organizationId, routineId: routineId.data, text: testText });
        return started ? context.json(started) : context.json(notFound, 404);
      } catch (error) {
        if (error instanceof ClaudeRoutineFireError) return context.json({ error: error.message }, 502);
        throw error;
      }
    })
    .delete("/:routineId", async (context) => {
      const granted = await access(context.req.raw.headers, true);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const routineId = idSchema.safeParse(context.req.param("routineId"));
      if (!routineId.success) return context.json(notFound, 404);
      return (await dependencies.delete(granted.organizationId, routineId.data))
        ? context.body(null, 204)
        : context.json(notFound, 404);
    });
}
