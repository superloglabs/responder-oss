import { Hono } from "hono";
import {
  getCodebaseKnowledgeRepository,
  listCodebaseKnowledgeRepositories,
} from "@responder/core/db/knowledge-base";
import { getActiveTenant } from "../tenant.js";
import { requestCodebaseKnowledgeRefresh } from "./queue.js";

export const knowledgeRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    return context.json({
      repositories: await listCodebaseKnowledgeRepositories(
        tenant.organizationId,
      ),
    });
  })
  .get("/:repositoryId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const repository = await getCodebaseKnowledgeRepository({
      organizationId: tenant.organizationId,
      repositoryId: context.req.param("repositoryId"),
    });
    return repository
      ? context.json(repository)
      : context.json({ error: "Repository not found" }, 404);
  })
  .post("/:repositoryId/refresh", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    try {
      const refresh = await requestCodebaseKnowledgeRefresh({
        force: true,
        organizationId: tenant.organizationId,
        repositoryId: context.req.param("repositoryId"),
      });
      if (!refresh) {
        return context.json({ error: "Repository not found" }, 404);
      }
      return context.json({ queued: refresh.jobId !== null }, 202);
    } catch (error) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "codebase_knowledge_refresh_queue_failed",
        organizationId: tenant.organizationId,
        repositoryId: context.req.param("repositoryId"),
      }));
      return context.json(
        { error: "Unable to refresh codebase knowledge" },
        502,
      );
    }
  });
