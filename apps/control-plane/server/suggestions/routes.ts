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
const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

function decodeCursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    return null;
  }
}

function encodeCursor(cursor: { createdAt: Date; id: string } | null) {
  return cursor
    ? Buffer.from(JSON.stringify({
        createdAt: cursor.createdAt.toISOString(),
        id: cursor.id,
      })).toString("base64url")
    : null;
}

export const suggestionRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const query = listQuerySchema.safeParse(context.req.query());
    if (!query.success) {
      return context.json({ error: "Invalid suggestion list query" }, 400);
    }
    const cursor = decodeCursor(query.data.cursor);
    if (cursor === null) {
      return context.json({ error: "Invalid suggestion cursor" }, 400);
    }
    const [page, settings] = await Promise.all([
      listSuggestions(tenant.organizationId, {
        limit: query.data.limit,
        ...(cursor ? { cursor } : {}),
      }),
      getSuggestionSettings(tenant.organizationId),
    ]);
    return context.json({
      suggestions: page.suggestions,
      nextCursor: encodeCursor(page.nextCursor),
      settings,
    });
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
      const firstJob = jobs[0];
      if (!firstJob) {
        throw new SuggestionPullRequestError(
          "This suggestion does not have a code change",
          "not_available",
        );
      }
      return context.json(
        {
          requestId: firstJob.requestId,
          requestIds: jobs.map((job) => job.requestId),
          sessionId: `openai-daytona:${firstJob.jobId}`,
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
