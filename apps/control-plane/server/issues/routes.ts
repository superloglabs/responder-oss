import {
  getIssueDetail,
  listIssues,
  setIssueArchived,
} from "../../../../packages/core/src/db/issues.js";
import { IssuePullRequestError } from "../../../../packages/core/src/db/pull-requests.js";
import { Hono } from "hono";
import { z } from "zod";
import { getActiveTenant } from "../tenant.js";
import { startIssueRemediation } from "./remediation.js";

const updateIssueSchema = z.object({ archived: z.boolean() });
const createPullRequestSchema = z.object({ remediationId: z.uuid() });

export const issueRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    return context.json({
      issues: await listIssues(
        tenant.organizationId,
        context.req.query("showArchived") === "true",
      ),
    });
  })
  .get("/:issueId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const detail = await getIssueDetail(
      tenant.organizationId,
      context.req.param("issueId"),
    );
    if (!detail) return context.json({ error: "Issue not found" }, 404);
    return context.json(detail);
  })
  .post("/:issueId/pull-requests", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = createPullRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "Invalid code remediation" }, 400);
    }

    let result;
    try {
      result = await startIssueRemediation({
        issueId: context.req.param("issueId"),
        organizationId: tenant.organizationId,
        remediationId: parsed.data.remediationId,
      });
    } catch (error) {
      if (error instanceof IssuePullRequestError) {
        return context.json(
          { error: error.message },
          error.code === "issue_not_found" ? 404 : 409,
        );
      }
      throw error;
    }
    if (!result.ok) {
      return context.json({ error: result.error }, result.status);
    }
    return context.json(
      { requestId: result.requestId, sessionId: result.sessionId },
      202,
    );
  })
  .patch("/:issueId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const parsed = updateIssueSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "Invalid issue update" }, 400);
    }
    const issue = await setIssueArchived({
      archived: parsed.data.archived,
      issueId: context.req.param("issueId"),
      organizationId: tenant.organizationId,
    });
    if (!issue) return context.json({ error: "Issue not found" }, 404);
    return context.json({ issue });
  });
