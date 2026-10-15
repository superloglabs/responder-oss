import { and, count, desc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { decryptCredentials, encryptCredentials } from "../credentials/encryption.js";
import type { SyntheticCheckInput, SyntheticHeaderInput } from "../synthetics/schema.js";
import type {
  SyntheticAssertion,
  SyntheticAssertionResult,
  SyntheticHeader,
  SyntheticMethod,
  SyntheticRequest,
  SyntheticResponse,
  SyntheticRunResult,
  SyntheticRunStatus,
  SyntheticTimings,
} from "../synthetics/types.js";
import { getDatabase } from "./client.js";
import {
  organizationCapabilities,
  syntheticCheckEpisodes,
  syntheticCheckRuns,
  syntheticChecks,
} from "./schema.js";

export type SyntheticSlackTarget = { channelId: string; integrationAccountId: string };

export type SyntheticCheck = {
  assertions: SyntheticAssertion[];
  body: string | null;
  consecutiveFailures: number;
  createdAt: string;
  enabled: boolean;
  failuresToAlert: number;
  followRedirects: boolean;
  // Secret values read as empty.
  headers: SyntheticHeader[];
  id: string;
  intervalSeconds: number;
  lastRunAt: string | null;
  lastStatus: SyntheticRunStatus | null;
  method: SyntheticMethod;
  name: string;
  retries: number;
  slack: SyntheticSlackTarget | null;
  statusSince: string | null;
  timeoutMs: number;
  updatedAt: string;
  url: string;
};

export type SyntheticCheckSummary = SyntheticCheck & {
  // Mean duration of the runs in the last day that did not fail.
  averageDurationMs: number | null;
  // Statuses of the latest runs, oldest first.
  recent: SyntheticRunStatus[];
  // Share of runs in the last day that did not fail, 0 to 1.
  uptime: number | null;
};

export type SyntheticCheckRun = {
  assertions: SyntheticAssertionResult[];
  attempts: number;
  durationMs: number;
  error: string | null;
  id: string;
  location: string;
  response: SyntheticResponse | null;
  startedAt: string;
  status: SyntheticRunStatus;
  statusCode: number | null;
  timings: SyntheticTimings;
};

// A run as listed, without its assertions and response.
export type SyntheticCheckRunSummary = Omit<SyntheticCheckRun, "assertions" | "response">;

export type SyntheticCheckEpisode = {
  endedAt: string | null;
  failedRuns: number;
  id: string;
  reason: string;
  startedAt: string;
  state: "failing" | "resolved";
};

const checkColumns = {
  assertions: syntheticChecks.assertions,
  body: syntheticChecks.body,
  consecutiveFailures: syntheticChecks.consecutiveFailures,
  createdAt: syntheticChecks.createdAt,
  enabled: syntheticChecks.enabled,
  failuresToAlert: syntheticChecks.failuresToAlert,
  followRedirects: syntheticChecks.followRedirects,
  headers: syntheticChecks.headers,
  id: syntheticChecks.id,
  intervalSeconds: syntheticChecks.intervalSeconds,
  lastRunAt: syntheticChecks.lastRunAt,
  lastStatus: syntheticChecks.lastStatus,
  method: syntheticChecks.method,
  name: syntheticChecks.name,
  retries: syntheticChecks.retries,
  slackChannelId: syntheticChecks.slackChannelId,
  slackIntegrationAccountId: syntheticChecks.slackIntegrationAccountId,
  statusSince: syntheticChecks.statusSince,
  timeoutMs: syntheticChecks.timeoutMs,
  updatedAt: syntheticChecks.updatedAt,
  url: syntheticChecks.url,
};

type CheckRow = Omit<SyntheticCheck, "createdAt" | "lastRunAt" | "slack" | "statusSince" | "updatedAt"> & {
  createdAt: Date;
  lastRunAt: Date | null;
  slackChannelId: string | null;
  slackIntegrationAccountId: string | null;
  statusSince: Date | null;
  updatedAt: Date;
};

function slackTarget(channelId: string | null, integrationAccountId: string | null): SyntheticSlackTarget | null {
  return channelId && integrationAccountId ? { channelId, integrationAccountId } : null;
}

function toCheck(row: CheckRow): SyntheticCheck {
  const { slackChannelId, slackIntegrationAccountId, ...rest } = row;
  return {
    ...rest,
    createdAt: row.createdAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    slack: slackTarget(slackChannelId, slackIntegrationAccountId),
    statusSince: row.statusSince?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// How many latest runs the list shows per check.
const recentRuns = 30;

export async function listSyntheticChecks(organizationId: string): Promise<SyntheticCheckSummary[]> {
  const result = await getDatabase().execute<{
    average_duration_ms: number | string | null;
    id: string;
    passing: number | string;
    recent: SyntheticRunStatus[] | null;
    total: number | string;
  }>(sql`
    select check_row.id, stats.total, stats.passing, stats.average_duration_ms, latest.recent
    from ${syntheticChecks} check_row
    left join lateral (
      select count(*) as total,
        count(*) filter (where run.status <> 'failed') as passing,
        avg(run.duration_ms) filter (where run.status <> 'failed') as average_duration_ms
      from ${syntheticCheckRuns} run
      where run.check_id = check_row.id and run.started_at > now() - interval '1 day'
    ) stats on true
    left join lateral (
      select array_agg(status order by started_at) as recent
      from (
        select run.status, run.started_at from ${syntheticCheckRuns} run
        where run.check_id = check_row.id
        order by run.started_at desc
        limit ${recentRuns}
      ) latest_runs
    ) latest on true
    where check_row.organization_id = ${organizationId}
  `);
  const stats = new Map(result.rows.map((row) => [row.id, row]));
  const rows = await getDatabase()
    .select(checkColumns)
    .from(syntheticChecks)
    .where(eq(syntheticChecks.organizationId, organizationId))
    .orderBy(syntheticChecks.name, syntheticChecks.id);
  return rows.map((row) => {
    const stat = stats.get(row.id);
    const total = Number(stat?.total ?? 0);
    return {
      ...toCheck(row),
      averageDurationMs: stat?.average_duration_ms == null ? null : Number(stat.average_duration_ms),
      recent: stat?.recent ?? [],
      uptime: total > 0 ? Number(stat?.passing ?? 0) / total : null,
    };
  });
}

export async function findSyntheticCheck(organizationId: string, checkId: string): Promise<SyntheticCheck | null> {
  const rows = await getDatabase()
    .select(checkColumns)
    .from(syntheticChecks)
    .where(and(eq(syntheticChecks.organizationId, organizationId), eq(syntheticChecks.id, checkId)))
    .limit(1);
  return rows[0] ? toCheck(rows[0]) : null;
}

function decryptSecrets(encrypted: string | null): Record<string, string> {
  return encrypted ? decryptCredentials<Record<string, string>>(encrypted) : {};
}

// The saved secret header values, by lowercased name, when the check is the
// workspace's.
export async function syntheticCheckSecrets(
  organizationId: string,
  checkId: string,
): Promise<{ secrets: Record<string, string>; url: string } | null> {
  const [row] = await getDatabase()
    .select({ encryptedSecrets: syntheticChecks.encryptedSecrets, url: syntheticChecks.url })
    .from(syntheticChecks)
    .where(and(eq(syntheticChecks.organizationId, organizationId), eq(syntheticChecks.id, checkId)))
    .limit(1);
  return row ? { secrets: decryptSecrets(row.encryptedSecrets), url: row.url } : null;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// Headers as stored, with secret values split out. A secret left blank keeps
// its saved value, but only while the URL keeps its origin, so a saved
// secret cannot be sent to another host without entering it again.
export function syntheticHeaders(
  input: readonly SyntheticHeaderInput[],
  saved: { secrets: Record<string, string>; url: string } | null,
  url: string,
): { error: string } | { headers: SyntheticHeader[]; secrets: Record<string, string> } {
  const headers: SyntheticHeader[] = [];
  const secrets: Record<string, string> = {};
  const names = new Set<string>();
  const keep = saved && sameOrigin(saved.url, url) ? saved.secrets : {};
  for (const header of input) {
    const name = header.name.toLowerCase();
    if (names.has(name)) return { error: `Set the ${header.name} header once` };
    names.add(name);
    if (header.secret) {
      const value = header.value || keep[name];
      if (!value) {
        return {
          error: saved?.secrets[name]
            ? `Enter the ${header.name} value again, since the URL's host changed`
            : `Enter a value for the ${header.name} header`,
        };
      }
      secrets[name] = value;
      headers.push({ name: header.name, secret: true, value: "" });
    } else {
      headers.push({ name: header.name, secret: false, value: header.value ?? "" });
    }
  }
  return { headers, secrets };
}

// The request to make, with secret header values filled in.
export function syntheticRequest(
  check: Pick<SyntheticCheck, "body" | "followRedirects" | "headers" | "method" | "timeoutMs" | "url">,
  secrets: Record<string, string>,
): SyntheticRequest {
  return {
    body: check.body,
    followRedirects: check.followRedirects,
    headers: check.headers.map((header) =>
      header.secret ? { ...header, value: secrets[header.name.toLowerCase()] ?? "" } : header,
    ),
    method: check.method,
    timeoutMs: check.timeoutMs,
    url: check.url,
  };
}

function checkValues(input: SyntheticCheckInput, headers: SyntheticHeader[], secrets: Record<string, string>) {
  return {
    assertions: input.assertions,
    body: input.body || null,
    enabled: input.enabled,
    encryptedSecrets: Object.keys(secrets).length > 0 ? encryptCredentials(secrets) : null,
    failuresToAlert: input.failuresToAlert,
    followRedirects: input.followRedirects,
    headers,
    intervalSeconds: input.intervalSeconds,
    method: input.method,
    name: input.name,
    retries: input.retries,
    slackChannelId: input.slack?.channelId ?? null,
    slackIntegrationAccountId: input.slack?.integrationAccountId ?? null,
    timeoutMs: input.timeoutMs,
    url: input.url,
  };
}

// Checks one workspace can have, so one workspace cannot crowd out the
// others' runs.
export const maxSyntheticChecks = 100;

export async function createSyntheticCheck(
  organizationId: string,
  input: SyntheticCheckInput & { createdBy: string },
): Promise<{ check: SyntheticCheck } | { error: string; status: 400 }> {
  const headers = syntheticHeaders(input.headers, null, input.url);
  if ("error" in headers) return { error: headers.error, status: 400 };
  const [existing] = await getDatabase()
    .select({ checks: count() })
    .from(syntheticChecks)
    .where(eq(syntheticChecks.organizationId, organizationId));
  if ((existing?.checks ?? 0) >= maxSyntheticChecks) {
    return { error: `A workspace can have up to ${maxSyntheticChecks} synthetic checks`, status: 400 };
  }
  const [row] = await getDatabase()
    .insert(syntheticChecks)
    .values({ ...checkValues(input, headers.headers, headers.secrets), createdBy: input.createdBy, organizationId })
    .returning({ id: syntheticChecks.id });
  const check = await findSyntheticCheck(organizationId, row!.id);
  return { check: check! };
}

// JSON with object keys sorted, since jsonb does not keep their order.
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

// Ends an open episode without posting a recovery, for a check that changed
// or stopped running.
async function endOpenEpisode(executor: Pick<ReturnType<typeof getDatabase>, "update">, checkId: string) {
  const now = new Date();
  await executor
    .update(syntheticCheckEpisodes)
    .set({ endedAt: now, recoveryNotifiedAt: now, state: "resolved", updatedAt: now })
    .where(and(eq(syntheticCheckEpisodes.checkId, checkId), eq(syntheticCheckEpisodes.state, "failing")));
}

// Replaces the check. Changing the request or assertions, or turning the
// check off, ends its open episode and starts its failure count again.
export async function updateSyntheticCheck(
  organizationId: string,
  checkId: string,
  input: SyntheticCheckInput,
): Promise<{ check: SyntheticCheck } | { error: string; status: 400 | 404 }> {
  const current = await findSyntheticCheck(organizationId, checkId);
  const saved = current ? await syntheticCheckSecrets(organizationId, checkId) : null;
  if (!current || !saved) return { error: "Check not found", status: 404 };
  const headers = syntheticHeaders(input.headers, saved, input.url);
  if ("error" in headers) return { error: headers.error, status: 400 };
  const values = checkValues(input, headers.headers, headers.secrets);
  const requestChanged =
    stableJson([current.method, current.url, current.headers, current.body, current.timeoutMs, current.followRedirects, current.assertions]) !==
      stableJson([values.method, values.url, values.headers, values.body, values.timeoutMs, values.followRedirects, values.assertions]) ||
    stableJson(saved.secrets) !== stableJson(headers.secrets);
  await getDatabase().transaction(async (transaction) => {
    await transaction
      .update(syntheticChecks)
      .set({
        ...values,
        ...(requestChanged || !input.enabled ? { consecutiveFailures: 0 } : {}),
        // A changed request runs again soon.
        ...(requestChanged ? { lastRunAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(syntheticChecks.organizationId, organizationId), eq(syntheticChecks.id, checkId)));
    if (requestChanged || !input.enabled) await endOpenEpisode(transaction, checkId);
  });
  return { check: (await findSyntheticCheck(organizationId, checkId))! };
}

export async function deleteSyntheticCheck(organizationId: string, checkId: string): Promise<boolean> {
  const deleted = await getDatabase()
    .delete(syntheticChecks)
    .where(and(eq(syntheticChecks.organizationId, organizationId), eq(syntheticChecks.id, checkId)))
    .returning({ id: syntheticChecks.id });
  return deleted.length > 0;
}

export type DueSyntheticCheck = SyntheticCheck & {
  organizationId: string;
  // Whether the run's metrics go to the workspace's telemetry: true when the
  // workspace has the telemetry capability.
  sendMetrics: boolean;
  request: SyntheticRequest;
};

// Claims enabled checks whose interval has passed, for workspaces that can
// use alerts. Claiming stamps the run time, so another worker skips them. A
// check whose attempts can outlast its interval waits for them, so its runs
// never overlap and record out of order.
export async function claimDueSyntheticChecks(limit: number): Promise<DueSyntheticCheck[]> {
  if (limit <= 0) return [];
  const result = await getDatabase().execute<{ encrypted_secrets: string | null; id: string; organization_id: string; telemetry: boolean }>(sql`
    update ${syntheticChecks} set last_run_at = now()
    where ${syntheticChecks.id} in (
      select check_row.id from ${syntheticChecks} check_row
      join ${organizationCapabilities} alerts
        on alerts.organization_id = check_row.organization_id and alerts.capability = 'alerts' and alerts.enabled
      where check_row.enabled
        and (check_row.last_run_at is null
          or check_row.last_run_at <= now() - make_interval(secs => greatest(
            check_row.interval_seconds,
            -- Every attempt timing out, a second between attempts, and margin.
            ceil(check_row.timeout_ms * (check_row.retries + 1) / 1000.0)::integer + check_row.retries + 5
          )))
      order by check_row.last_run_at asc nulls first
      limit ${limit}
      for update of check_row skip locked
    )
    returning id, organization_id, encrypted_secrets, exists (
      select 1 from ${organizationCapabilities} telemetry
      where telemetry.organization_id = ${syntheticChecks.organizationId} and telemetry.capability = 'telemetry' and telemetry.enabled
    ) as telemetry
  `);
  if (result.rows.length === 0) return [];
  const claimed = new Map(result.rows.map((row) => [row.id, row]));
  const rows = await getDatabase()
    .select(checkColumns)
    .from(syntheticChecks)
    .where(or(...[...claimed.keys()].map((id) => eq(syntheticChecks.id, id))));
  return rows.flatMap((row) => {
    const claim = claimed.get(row.id)!;
    const check = toCheck(row);
    let secrets: Record<string, string>;
    try {
      secrets = decryptSecrets(claim.encrypted_secrets);
    } catch {
      // A secret that cannot be read sends the header blank, and the run
      // shows the failure.
      secrets = {};
    }
    return [{
      ...check,
      organizationId: claim.organization_id,
      request: syntheticRequest(check, secrets),
      sendMetrics: claim.telemetry,
    }];
  });
}

// Records a run and returns the failures in a row, or null when the check
// was changed or deleted since it was claimed: such a run is kept but does
// not count.
export async function recordSyntheticRun(
  check: Pick<SyntheticCheck, "id" | "updatedAt">,
  run: SyntheticRunResult,
  location: string,
): Promise<number | null> {
  const failed = run.status === "failed";
  return getDatabase().transaction(async (transaction) => {
    const inserted = await transaction.execute<{ id: string }>(sql`
      insert into ${syntheticCheckRuns}
        (check_id, started_at, status, location, attempts, duration_ms, timings, status_code, error, assertions, response)
      select ${check.id}, ${run.startedAt}::timestamptz, ${run.status}, ${location}, ${run.attempts}, ${run.durationMs},
        ${JSON.stringify(run.timings)}::jsonb, ${run.response?.statusCode ?? null}::integer, ${run.error},
        ${JSON.stringify(run.assertions)}::jsonb,
        ${run.status === "passed" || !run.response ? null : JSON.stringify(run.response)}::jsonb
      where exists (select 1 from ${syntheticChecks} where ${syntheticChecks.id} = ${check.id})
      returning id
    `);
    if (inserted.rows.length === 0) return null;
    const updated = await transaction.execute<{ consecutive_failures: number }>(sql`
      update ${syntheticChecks} set
        consecutive_failures = case when ${failed} then consecutive_failures + 1 else 0 end,
        status_since = case
          when last_status is null or (last_status = 'failed') <> ${failed} then ${run.startedAt}::timestamptz
          else status_since end,
        last_status = ${run.status}
      where id = ${check.id}
        -- The version is read back in JavaScript, which keeps milliseconds.
        and date_trunc('milliseconds', updated_at) = ${check.updatedAt}::timestamptz
        and enabled
      returning consecutive_failures
    `);
    const row = updated.rows[0];
    return row ? Number(row.consecutive_failures) : null;
  });
}

const runSummaryColumns = {
  attempts: syntheticCheckRuns.attempts,
  durationMs: syntheticCheckRuns.durationMs,
  error: syntheticCheckRuns.error,
  id: syntheticCheckRuns.id,
  location: syntheticCheckRuns.location,
  startedAt: syntheticCheckRuns.startedAt,
  status: syntheticCheckRuns.status,
  statusCode: syntheticCheckRuns.statusCode,
  timings: syntheticCheckRuns.timings,
};

// The latest runs, newest first, before a run's start when paging.
export async function listSyntheticCheckRuns(
  checkId: string,
  options: { before?: { id: string; startedAt: string }; limit?: number; status?: SyntheticRunStatus } = {},
): Promise<SyntheticCheckRunSummary[]> {
  const before = options.before
    ? or(
        lt(syntheticCheckRuns.startedAt, new Date(options.before.startedAt)),
        and(eq(syntheticCheckRuns.startedAt, new Date(options.before.startedAt)), lt(syntheticCheckRuns.id, options.before.id)),
      )
    : undefined;
  const rows = await getDatabase()
    .select(runSummaryColumns)
    .from(syntheticCheckRuns)
    .where(
      and(
        eq(syntheticCheckRuns.checkId, checkId),
        before,
        options.status ? eq(syntheticCheckRuns.status, options.status) : undefined,
      ),
    )
    .orderBy(desc(syntheticCheckRuns.startedAt), desc(syntheticCheckRuns.id))
    .limit(options.limit ?? 50);
  return rows.map((row) => ({ ...row, startedAt: row.startedAt.toISOString() }));
}

export async function findSyntheticCheckRun(checkId: string, runId: string): Promise<SyntheticCheckRun | null> {
  const [row] = await getDatabase()
    .select({ ...runSummaryColumns, assertions: syntheticCheckRuns.assertions, response: syntheticCheckRuns.response })
    .from(syntheticCheckRuns)
    .where(and(eq(syntheticCheckRuns.checkId, checkId), eq(syntheticCheckRuns.id, runId)))
    .limit(1);
  return row ? { ...row, startedAt: row.startedAt.toISOString() } : null;
}

export type SyntheticCheckBucket = {
  averageMs: SyntheticTimings & { totalMs: number } | null;
  bucket: string;
  degraded: number;
  failed: number;
  passed: number;
};

export type SyntheticCheckStats = {
  averageDurationMs: number | null;
  buckets: SyntheticCheckBucket[];
  p95DurationMs: number | null;
  runs: number;
  // Share of runs that did not fail, 0 to 1.
  uptime: number | null;
};

// Runs since `since`, in buckets of `bucketSeconds`, with the average phase
// timings of the runs that did not fail.
export async function syntheticCheckStats(checkId: string, since: Date, bucketSeconds: number): Promise<SyntheticCheckStats> {
  const timing = (field: keyof SyntheticTimings) =>
    sql.raw(`avg((timings->>'${field}')::float8) filter (where status <> 'failed')`);
  const [buckets, totals] = await Promise.all([
    getDatabase().execute<{
      bucket: Date | string;
      connect_ms: number | null;
      degraded: number | string;
      dns_ms: number | null;
      download_ms: number | null;
      failed: number | string;
      first_byte_ms: number | null;
      passed: number | string;
      tls_ms: number | null;
      total_ms: number | null;
    }>(sql`
      select date_bin(make_interval(secs => ${bucketSeconds}), started_at, ${since.toISOString()}::timestamptz) as bucket,
        count(*) filter (where status = 'passed') as passed,
        count(*) filter (where status = 'degraded') as degraded,
        count(*) filter (where status = 'failed') as failed,
        avg(duration_ms) filter (where status <> 'failed') as total_ms,
        ${timing("dnsMs")} as dns_ms,
        ${timing("connectMs")} as connect_ms,
        ${timing("tlsMs")} as tls_ms,
        ${timing("firstByteMs")} as first_byte_ms,
        ${timing("downloadMs")} as download_ms
      from ${syntheticCheckRuns}
      where check_id = ${checkId} and started_at >= ${since.toISOString()}::timestamptz
      group by 1
      order by 1
    `),
    getDatabase().execute<{ average: number | null; p95: number | null; passing: number | string; total: number | string }>(sql`
      select count(*) as total,
        count(*) filter (where status <> 'failed') as passing,
        avg(duration_ms) filter (where status <> 'failed') as average,
        percentile_cont(0.95) within group (order by duration_ms) filter (where status <> 'failed') as p95
      from ${syntheticCheckRuns}
      where check_id = ${checkId} and started_at >= ${since.toISOString()}::timestamptz
    `),
  ]);
  const total = totals.rows[0];
  const runs = Number(total?.total ?? 0);
  const number = (value: number | null) => (value === null ? 0 : Number(value));
  return {
    averageDurationMs: total?.average == null ? null : Number(total.average),
    buckets: buckets.rows.map((row) => ({
      averageMs:
        row.total_ms === null
          ? null
          : {
              connectMs: number(row.connect_ms),
              dnsMs: number(row.dns_ms),
              downloadMs: number(row.download_ms),
              firstByteMs: number(row.first_byte_ms),
              tlsMs: number(row.tls_ms),
              totalMs: number(row.total_ms),
            },
      bucket: new Date(row.bucket).toISOString(),
      degraded: Number(row.degraded),
      failed: Number(row.failed),
      passed: Number(row.passed),
    })),
    p95DurationMs: total?.p95 == null ? null : Number(total.p95),
    runs,
    uptime: runs > 0 ? Number(total?.passing ?? 0) / runs : null,
  };
}

// Deletes runs that started before `before`, at most `limit` at once.
export async function deleteSyntheticCheckRunsBefore(before: Date, limit: number): Promise<number> {
  const result = await getDatabase().execute(sql`
    delete from ${syntheticCheckRuns}
    where id in (
      select id from ${syntheticCheckRuns} where started_at < ${before.toISOString()}::timestamptz limit ${limit}
    )
  `);
  return result.rowCount ?? 0;
}

export async function listSyntheticCheckEpisodes(checkId: string, limit = 20): Promise<SyntheticCheckEpisode[]> {
  const rows = await getDatabase()
    .select({
      endedAt: syntheticCheckEpisodes.endedAt,
      failedRuns: syntheticCheckEpisodes.failedRuns,
      id: syntheticCheckEpisodes.id,
      reason: syntheticCheckEpisodes.reason,
      startedAt: syntheticCheckEpisodes.startedAt,
      state: syntheticCheckEpisodes.state,
    })
    .from(syntheticCheckEpisodes)
    .where(eq(syntheticCheckEpisodes.checkId, checkId))
    .orderBy(desc(syntheticCheckEpisodes.startedAt), desc(syntheticCheckEpisodes.id))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    endedAt: row.endedAt?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
  }));
}

export type OpenSyntheticCheckEpisode = {
  failedRuns: number;
  id: string;
  slackChannelId: string | null;
  slackIntegrationAccountId: string | null;
  slackMessageTs: string | null;
  startedAt: Date;
};

const openEpisodeColumns = {
  failedRuns: syntheticCheckEpisodes.failedRuns,
  id: syntheticCheckEpisodes.id,
  slackChannelId: syntheticCheckEpisodes.slackChannelId,
  slackIntegrationAccountId: syntheticCheckEpisodes.slackIntegrationAccountId,
  slackMessageTs: syntheticCheckEpisodes.slackMessageTs,
  startedAt: syntheticCheckEpisodes.startedAt,
};

export async function openSyntheticCheckEpisode(checkId: string): Promise<OpenSyntheticCheckEpisode | null> {
  const [row] = await getDatabase()
    .select(openEpisodeColumns)
    .from(syntheticCheckEpisodes)
    .where(and(eq(syntheticCheckEpisodes.checkId, checkId), eq(syntheticCheckEpisodes.state, "failing")))
    .limit(1);
  return row ?? null;
}

// Null when the check already has an open episode, or was turned off or
// changed since `checkUpdatedAt`, the version the run used.
export async function startSyntheticCheckEpisode(input: {
  checkId: string;
  checkUpdatedAt: string;
  failedRuns: number;
  reason: string;
  slack: SyntheticSlackTarget | null;
}): Promise<OpenSyntheticCheckEpisode | null> {
  const result = await getDatabase().execute<{
    failed_runs: number;
    id: string;
    slack_channel_id: string | null;
    slack_integration_account_id: string | null;
    slack_message_ts: string | null;
    started_at: Date | string;
  }>(sql`
    insert into ${syntheticCheckEpisodes} (check_id, reason, failed_runs, slack_channel_id, slack_integration_account_id)
    select ${input.checkId}, ${input.reason.slice(0, 500)}, ${input.failedRuns},
      ${input.slack?.channelId ?? null}, ${input.slack?.integrationAccountId ?? null}
    where exists (
      select 1 from ${syntheticChecks}
      where ${syntheticChecks.id} = ${input.checkId}
        and ${syntheticChecks.enabled}
        and date_trunc('milliseconds', ${syntheticChecks.updatedAt}) = ${input.checkUpdatedAt}::timestamptz
    )
    on conflict do nothing
    returning id, failed_runs, slack_channel_id, slack_integration_account_id, slack_message_ts, started_at
  `);
  const row = result.rows[0];
  return row
    ? {
        failedRuns: Number(row.failed_runs),
        id: row.id,
        slackChannelId: row.slack_channel_id,
        slackIntegrationAccountId: row.slack_integration_account_id,
        slackMessageTs: row.slack_message_ts,
        startedAt: new Date(row.started_at),
      }
    : null;
}

export async function continueSyntheticCheckEpisode(episodeId: string): Promise<void> {
  await getDatabase()
    .update(syntheticCheckEpisodes)
    .set({ failedRuns: sql`${syntheticCheckEpisodes.failedRuns} + 1`, updatedAt: new Date() })
    .where(and(eq(syntheticCheckEpisodes.id, episodeId), eq(syntheticCheckEpisodes.state, "failing")));
}

// False when the episode was already ended, by an edit or another worker.
export async function resolveSyntheticCheckEpisode(episodeId: string): Promise<boolean> {
  const now = new Date();
  const rows = await getDatabase()
    .update(syntheticCheckEpisodes)
    .set({ endedAt: now, state: "resolved", updatedAt: now })
    .where(and(eq(syntheticCheckEpisodes.id, episodeId), eq(syntheticCheckEpisodes.state, "failing")))
    .returning({ id: syntheticCheckEpisodes.id });
  return rows.length > 0;
}

export async function setSyntheticCheckEpisodeMessage(episodeId: string, messageTs: string): Promise<void> {
  await getDatabase()
    .update(syntheticCheckEpisodes)
    .set({ slackMessageTs: messageTs, updatedAt: new Date() })
    .where(eq(syntheticCheckEpisodes.id, episodeId));
}

export async function markSyntheticCheckRecoveryNotified(episodeId: string): Promise<void> {
  await getDatabase()
    .update(syntheticCheckEpisodes)
    .set({ recoveryNotifiedAt: new Date() })
    .where(eq(syntheticCheckEpisodes.id, episodeId));
}

export type UnannouncedSyntheticCheckRecovery = OpenSyntheticCheckEpisode & { endedAt: Date };

// Recoveries of announced episodes whose reply has not been posted, ended
// within the last hour. Older ones are no longer worth posting.
export async function unannouncedSyntheticCheckRecoveries(checkId: string): Promise<UnannouncedSyntheticCheckRecovery[]> {
  const rows = await getDatabase()
    .select({ ...openEpisodeColumns, endedAt: syntheticCheckEpisodes.endedAt })
    .from(syntheticCheckEpisodes)
    .where(
      and(
        eq(syntheticCheckEpisodes.checkId, checkId),
        eq(syntheticCheckEpisodes.state, "resolved"),
        isNull(syntheticCheckEpisodes.recoveryNotifiedAt),
        isNotNull(syntheticCheckEpisodes.slackMessageTs),
        gte(syntheticCheckEpisodes.endedAt, sql`now() - interval '1 hour'`),
      ),
    );
  return rows.map((row) => ({ ...row, endedAt: row.endedAt! }));
}
