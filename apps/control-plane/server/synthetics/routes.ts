import { Hono } from "hono";
import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  createSyntheticCheck,
  deleteSyntheticCheck,
  findSyntheticCheck,
  findSyntheticCheckRun,
  listSyntheticCheckEpisodes,
  listSyntheticCheckRuns,
  listSyntheticChecks,
  syntheticCheckSecrets,
  syntheticCheckStats,
  syntheticHeaders,
  syntheticRequest,
  updateSyntheticCheck,
  type SyntheticSlackTarget,
} from "../../../../packages/core/src/db/synthetic-checks.js";
import { listTelemetryAlertSlackChannels } from "../../../../packages/core/src/db/telemetry-alerts.js";
import { refreshSlackChannelResources } from "../../../../packages/core/src/integrations/slack-channels.js";
import { runSyntheticAttempt } from "../../../../packages/core/src/synthetics/runner.js";
import { syntheticCheckInputSchema, syntheticTestSchema } from "../../../../packages/core/src/synthetics/schema.js";
import { getActiveTenant } from "../tenant.js";

// Synthetic checks: HTTP requests the worker makes on a schedule. They come
// with alerts, so they need the alerts capability.
export type SyntheticRouteDependencies = {
  createCheck: typeof createSyntheticCheck;
  deleteCheck: typeof deleteSyntheticCheck;
  episodes: typeof listSyntheticCheckEpisodes;
  findCheck: typeof findSyntheticCheck;
  findRun: typeof findSyntheticCheckRun;
  hasCapability: (organizationId: string, capability: "alerts") => Promise<boolean>;
  listChecks: typeof listSyntheticChecks;
  now: () => Date;
  refreshSlackChannels: (organizationId: string) => Promise<void>;
  runs: typeof listSyntheticCheckRuns;
  secrets: typeof syntheticCheckSecrets;
  slackChannels: typeof listTelemetryAlertSlackChannels;
  stats: typeof syntheticCheckStats;
  tenant: (
    headers: Headers,
  ) => Promise<
    | { ok: true; organizationId: string; user: { id: string } }
    | { error: string; ok: false; status: 401 | 403 | 409 }
  >;
  test: typeof runSyntheticAttempt;
  updateCheck: typeof updateSyntheticCheck;
};

const defaultDependencies: SyntheticRouteDependencies = {
  createCheck: createSyntheticCheck,
  deleteCheck: deleteSyntheticCheck,
  episodes: listSyntheticCheckEpisodes,
  findCheck: findSyntheticCheck,
  findRun: findSyntheticCheckRun,
  hasCapability: organizationHasCapability,
  listChecks: listSyntheticChecks,
  now: () => new Date(),
  refreshSlackChannels: (organizationId) => refreshSlackChannelResources(organizationId),
  runs: listSyntheticCheckRuns,
  secrets: syntheticCheckSecrets,
  slackChannels: listTelemetryAlertSlackChannels,
  stats: syntheticCheckStats,
  tenant: getActiveTenant,
  test: (request, assertions, options) =>
    runSyntheticAttempt(request, assertions, { ...options, allowLocal: process.env.NODE_ENV !== "production" }),
  updateCheck: updateSyntheticCheck,
};

// The detail page's ranges, and the bucket each is charted in.
const ranges = {
  "24h": { bucketSeconds: 900, ms: 86_400_000 },
  "7d": { bucketSeconds: 7_200, ms: 7 * 86_400_000 },
  "30d": { bucketSeconds: 28_800, ms: 30 * 86_400_000 },
} as const;

// Test requests a workspace can make per minute from the editor.
const testsPerMinute = 20;

const idSchema = z.uuid();
const runsQuerySchema = z.object({
  before: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
  status: z.enum(["passed", "degraded", "failed"]).optional(),
});

async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

export function createSyntheticRoutes(dependencies: SyntheticRouteDependencies = defaultDependencies) {
  const tests = new Map<string, number[]>();

  async function access(headers: Headers): Promise<
    | { ok: true; organizationId: string; userId: string }
    | { error: string; ok: false; status: 401 | 403 | 404 | 409 }
  > {
    const tenant = await dependencies.tenant(headers);
    if (tenant.ok === false) return { error: tenant.error, ok: false, status: tenant.status };
    if (!(await dependencies.hasCapability(tenant.organizationId, "alerts"))) {
      return { error: "Synthetic checks are not available", ok: false, status: 404 };
    }
    return { ok: true, organizationId: tenant.organizationId, userId: tenant.user.id };
  }

  async function slackProblem(organizationId: string, slack: SyntheticSlackTarget | null): Promise<string | null> {
    if (!slack) return null;
    const channels = await dependencies.slackChannels(organizationId);
    const found = channels.some(
      (channel) => channel.channelId === slack.channelId && channel.integrationAccountId === slack.integrationAccountId,
    );
    return found ? null : "Choose a Slack channel from a connected workspace";
  }

  // False when the workspace has made its test requests for the minute.
  function allowTest(organizationId: string): boolean {
    const now = dependencies.now().getTime();
    const recent = (tests.get(organizationId) ?? []).filter((time) => time > now - 60_000);
    if (recent.length >= testsPerMinute) return false;
    recent.push(now);
    tests.set(organizationId, recent);
    if (tests.size > 10_000) tests.clear();
    return true;
  }

  const notFound = { error: "Check not found" };

  return new Hono()
    .get("/", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      return context.json({ checks: await dependencies.listChecks(granted.organizationId) });
    })
    .post("/", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = syntheticCheckInputSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: body.error.issues[0]?.message ?? "Invalid check" }, 400);
      const problem = await slackProblem(granted.organizationId, body.data.slack);
      if (problem) return context.json({ error: problem }, 400);
      const created = await dependencies.createCheck(granted.organizationId, { ...body.data, createdBy: granted.userId });
      return "error" in created
        ? context.json({ error: created.error }, created.status)
        : context.json({ check: created.check }, 201);
    })
    .get("/slack-channels", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      return context.json({ channels: await dependencies.slackChannels(granted.organizationId) });
    })
    .post("/slack-channels/refresh", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      await dependencies.refreshSlackChannels(granted.organizationId);
      return context.json({ channels: await dependencies.slackChannels(granted.organizationId) });
    })
    // Makes the request once, now, and checks the assertions.
    .post("/test", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = syntheticTestSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: body.error.issues[0]?.message ?? "Invalid request" }, 400);
      const saved = body.data.checkId ? await dependencies.secrets(granted.organizationId, body.data.checkId) : null;
      if (body.data.checkId && !saved) return context.json(notFound, 404);
      const headers = syntheticHeaders(body.data.headers, saved, body.data.url);
      if ("error" in headers) return context.json({ error: headers.error }, 400);
      if (!allowTest(granted.organizationId)) {
        return context.json({ error: "Too many test requests. Try again in a minute." }, 429);
      }
      const result = await dependencies.test(
        syntheticRequest({ ...body.data, headers: headers.headers }, headers.secrets),
        body.data.assertions,
        { previewBytes: 65_536 },
      );
      return context.json({ result: { ...result, attempts: 1 } });
    })
    .get("/:checkId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const checkId = idSchema.safeParse(context.req.param("checkId"));
      if (!checkId.success) return context.json(notFound, 404);
      const check = await dependencies.findCheck(granted.organizationId, checkId.data);
      if (!check) return context.json(notFound, 404);
      const rangeName = context.req.query("range");
      const range = rangeName && rangeName in ranges ? ranges[rangeName as keyof typeof ranges] : ranges["24h"];
      const since = new Date(dependencies.now().getTime() - range.ms);
      const [stats, runs, episodes] = await Promise.all([
        dependencies.stats(check.id, since, range.bucketSeconds),
        dependencies.runs(check.id, { limit: 50 }),
        dependencies.episodes(check.id),
      ]);
      return context.json({
        bucketSeconds: range.bucketSeconds,
        check,
        episodes,
        runs,
        since: since.toISOString(),
        stats,
      });
    })
    .get("/:checkId/runs", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const checkId = idSchema.safeParse(context.req.param("checkId"));
      const query = runsQuerySchema.safeParse(context.req.query());
      if (!checkId.success) return context.json(notFound, 404);
      if (!query.success) return context.json({ error: "Invalid run filter" }, 400);
      if (!(await dependencies.findCheck(granted.organizationId, checkId.data))) return context.json(notFound, 404);
      const { before, beforeId, status } = query.data;
      return context.json({
        runs: await dependencies.runs(checkId.data, {
          ...(before && beforeId ? { before: { id: beforeId, startedAt: before } } : {}),
          limit: 50,
          ...(status ? { status } : {}),
        }),
      });
    })
    .get("/:checkId/runs/:runId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const checkId = idSchema.safeParse(context.req.param("checkId"));
      const runId = idSchema.safeParse(context.req.param("runId"));
      if (!checkId.success || !runId.success) return context.json(notFound, 404);
      if (!(await dependencies.findCheck(granted.organizationId, checkId.data))) return context.json(notFound, 404);
      const run = await dependencies.findRun(checkId.data, runId.data);
      return run ? context.json({ run }) : context.json({ error: "Run not found" }, 404);
    })
    .put("/:checkId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const checkId = idSchema.safeParse(context.req.param("checkId"));
      if (!checkId.success) return context.json(notFound, 404);
      const body = syntheticCheckInputSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: body.error.issues[0]?.message ?? "Invalid check" }, 400);
      const current = await dependencies.findCheck(granted.organizationId, checkId.data);
      if (!current) return context.json(notFound, 404);
      // A channel that has gone since the check was saved can stay, so other
      // changes still save; posting to it fails and is logged.
      const unchanged =
        current.slack?.channelId === body.data.slack?.channelId &&
        current.slack?.integrationAccountId === body.data.slack?.integrationAccountId;
      const problem = unchanged ? null : await slackProblem(granted.organizationId, body.data.slack);
      if (problem) return context.json({ error: problem }, 400);
      const updated = await dependencies.updateCheck(granted.organizationId, checkId.data, body.data);
      return "error" in updated
        ? context.json({ error: updated.error }, updated.status)
        : context.json({ check: updated.check });
    })
    .delete("/:checkId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const checkId = idSchema.safeParse(context.req.param("checkId"));
      if (!checkId.success) return context.json(notFound, 404);
      return (await dependencies.deleteCheck(granted.organizationId, checkId.data))
        ? context.body(null, 204)
        : context.json(notFound, 404);
    });
}
