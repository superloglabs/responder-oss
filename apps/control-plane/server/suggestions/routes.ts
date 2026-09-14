import { Hono } from "hono";
import { z } from "zod";
import {
  getSuggestionDetail,
  getSuggestionSettings,
  listSuggestions,
  setSuggestionSettings,
} from "../../../../packages/core/src/db/suggestions.js";
import {
  queueSuggestionPullRequests,
  SuggestionPullRequestError,
} from "../../../../packages/core/src/db/suggestion-pull-requests.js";
import { queueSuggestionRemediation } from "../investigations/queue.js";
import { getActiveTenant } from "../tenant.js";

const settingsSchema = z.object({ autoOpenPullRequests: z.boolean() });

export const suggestionRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const [suggestions, settings] = await Promise.all([
      listSuggestions(tenant.organizationId),
      getSuggestionSettings(tenant.organizationId),
    ]);
    return context.json({ suggestions, settings });
  })
  .patch("/settings", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const parsed = settingsSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "Invalid suggestion settings" }, 400);
    }
    return context.json({
      settings: await setSuggestionSettings({
        organizationId: tenant.organizationId,
        ...parsed.data,
      }),
    });
  })
  .get("/:suggestionId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const detail = await getSuggestionDetail(
      tenant.organizationId,
      context.req.param("suggestionId"),
    );
    if (!detail) return context.json({ error: "Suggestion not found" }, 404);
    return context.json(detail);
  })
  .post("/:suggestionId/pull-requests", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    try {
      const requests = await queueSuggestionPullRequests({
        organizationId: tenant.organizationId,
        suggestionId: context.req.param("suggestionId"),
      });
      const jobs = await Promise.all(
        requests.map((request) => queueSuggestionRemediation(request.id)),
      );
      return context.json(
        {
          requestId: jobs[0]!.requestId,
          requestIds: jobs.map((job) => job.requestId),
          sessionId: `openai-daytona:${jobs[0]!.jobId}`,
          sessionIds: jobs.map((job) => `openai-daytona:${job.jobId}`),
        },
        202,
      );
    } catch (error) {
      if (error instanceof SuggestionPullRequestError) {
        return context.json(
          { error: error.message },
          error.code === "suggestion_not_found" ? 404 : 409,
        );
      }
      throw error;
    }
  });
