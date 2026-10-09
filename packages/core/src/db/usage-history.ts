import { and, eq, gt, gte, inArray, isNotNull, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  agentModelUsage,
  agents,
  automationModelUsage,
  automationRuns,
  automations,
  investigations,
  sandboxUsage,
} from "./schema.js";

export const usageHistoryDayOptions = [7, 30, 90] as const;
export type UsageHistoryDays = (typeof usageHistoryDayOptions)[number];

// Reads the `days` query parameter. Other values fall back to 30 days.
export function parseUsageHistoryDays(value: string | undefined): UsageHistoryDays {
  return usageHistoryDayOptions.find((days) => String(days) === value) ?? 30;
}

// What the usage came from. Automation runs are attributed to their
// automation; runs of an automation that was deleted are grouped together.
export type UsageSource =
  | { automationId: string; kind: "automation"; name: string }
  | { kind: "deleted_automation" | "investigations" | "pull_requests" | "tag_mode" };

export interface UsageHistoryPoint {
  // Model usage charged, in dollars.
  aiCharge: number;
  // UTC calendar day, as YYYY-MM-DD.
  day: string;
  machineHours: number;
  source: string;
}

export interface UsageHistory {
  // Every day in the range, oldest first, including days without usage.
  days: string[];
  points: UsageHistoryPoint[];
  // Keyed by `UsageHistoryPoint.source`.
  sources: Record<string, UsageSource>;
}

// The first UTC day of a range of `days` days that ends today.
export function usageHistoryStart(days: number, now = new Date()): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

export function usageHistoryDays(start: Date, days: number): string[] {
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function utcDay(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD')`;
}

// Investigations started by the Slack thread agent are tag mode.
const investigationSource = sql`case when ${agents.purpose} = 'slack_thread' then 'tag_mode' else 'investigations' end`;
const automationSource = sql`coalesce(${automationRuns.automationId}::text, 'deleted_automation')`;

// Charged usage of an organization, or of one of its automations, per day
// and source since the start of the range. It counts what billing counts:
// billable sandbox time and Responder-funded model usage that was not waived.
// Days follow when the usage happened rather than when it was settled.
export async function getUsageHistory(input: {
  automationId?: string;
  days: UsageHistoryDays;
  now?: Date;
  organizationId: string;
}): Promise<UsageHistory> {
  const database = getDatabase();
  const since = usageHistoryStart(input.days, input.now);
  const automationOnly = input.automationId
    ? eq(automationRuns.automationId, input.automationId)
    : undefined;

  const sandboxSource = sql<string>`case when ${sandboxUsage.workload} = 'automation' then ${automationSource} when ${sandboxUsage.workload} = 'investigation' then ${investigationSource} else 'pull_requests' end`;
  // A period still running counts until its last heartbeat.
  const sandboxEnd = sql<Date | string>`coalesce(${sandboxUsage.stoppedAt}, ${sandboxUsage.heartbeatAt})`;
  // Each period is read on its own so that one crossing midnight or the
  // start of the range is split by day.
  const sandbox = database
    .select({ endedAt: sandboxEnd, source: sandboxSource, startedAt: sandboxUsage.startedAt })
    .from(sandboxUsage)
    .leftJoin(
      automationRuns,
      and(eq(sandboxUsage.workload, "automation"), eq(automationRuns.id, sandboxUsage.workloadId)),
    )
    .leftJoin(
      investigations,
      and(eq(sandboxUsage.workload, "investigation"), eq(investigations.id, sandboxUsage.workloadId)),
    )
    .leftJoin(agents, eq(agents.id, investigations.agentId))
    .where(and(
      eq(sandboxUsage.organizationId, input.organizationId),
      gt(sandboxEnd, since),
      eq(sandboxUsage.billable, true),
      isNull(sandboxUsage.waivedAt),
      input.automationId ? eq(sandboxUsage.workload, "automation") : undefined,
      automationOnly,
    ));

  const automationDay = utcDay(automationModelUsage.createdAt);
  const automationModel = database
    .select({
      day: automationDay,
      micros: sql<string>`coalesce(sum(${automationModelUsage.costMicros}), 0)`,
      source: sql<string>`${automationSource}`,
    })
    .from(automationModelUsage)
    .leftJoin(automationRuns, eq(automationRuns.id, automationModelUsage.runId))
    .where(and(
      eq(automationModelUsage.organizationId, input.organizationId),
      eq(automationModelUsage.inferenceSource, "responder"),
      gte(automationModelUsage.createdAt, since),
      isNotNull(automationModelUsage.completedAt),
      isNull(automationModelUsage.waivedAt),
      automationOnly,
    ))
    .groupBy(sql`1`, sql`3`);

  const agentDay = utcDay(agentModelUsage.createdAt);
  const agentModel = input.automationId
    ? Promise.resolve([])
    : database
      .select({
        day: agentDay,
        micros: sql<string>`coalesce(sum(${agentModelUsage.chargeMicros}), 0)`,
        source: sql<string>`case when ${agentModelUsage.workload} = 'investigation' then ${investigationSource} else 'pull_requests' end`,
      })
      .from(agentModelUsage)
      .leftJoin(
        investigations,
        and(eq(agentModelUsage.workload, "investigation"), eq(investigations.id, agentModelUsage.workloadId)),
      )
      .leftJoin(agents, eq(agents.id, investigations.agentId))
      .where(and(
        eq(agentModelUsage.organizationId, input.organizationId),
        eq(agentModelUsage.billable, true),
        gte(agentModelUsage.createdAt, since),
        isNull(agentModelUsage.waivedAt),
      ))
      .groupBy(sql`1`, sql`3`);

  const [sandboxRows, automationModelRows, agentModelRows] = await Promise.all([
    sandbox,
    automationModel,
    agentModel,
  ]);

  const automationIds = [...new Set(
    [...sandboxRows, ...automationModelRows, ...agentModelRows].map((row) => row.source),
  )].filter((source) => !nonAutomationSources.has(source));
  const names = automationIds.length
    ? await database
      .select({ id: automations.id, name: automations.name })
      .from(automations)
      .where(and(
        eq(automations.organizationId, input.organizationId),
        inArray(automations.id, automationIds),
      ))
    : [];
  const named = new Set(names.map((row) => row.id));
  // Automations that no longer exist share one source.
  const sourceKey = (source: string) =>
    nonAutomationSources.has(source) || named.has(source) ? source : "deleted_automation";

  const points = new Map<string, UsageHistoryPoint>();
  function point(day: string, source: string): UsageHistoryPoint {
    const key = `${day}\u0000${sourceKey(source)}`;
    let existing = points.get(key);
    if (!existing) {
      existing = { aiCharge: 0, day, machineHours: 0, source: sourceKey(source) };
      points.set(key, existing);
    }
    return existing;
  }
  for (const row of sandboxRows) {
    const periods = sandboxHoursByDay(new Date(row.startedAt), new Date(row.endedAt), since);
    for (const { day, hours } of periods) point(day, row.source).machineHours += hours;
  }
  for (const row of [...automationModelRows, ...agentModelRows]) {
    point(row.day, row.source).aiCharge += Number(row.micros) / 1_000_000;
  }

  return {
    days: usageHistoryDays(since, input.days),
    points: [...points.values()].sort((left, right) =>
      left.day.localeCompare(right.day) || left.source.localeCompare(right.source)),
    sources: usageSources([...points.values()], names),
  };
}

const dayMs = 24 * 60 * 60 * 1_000;

// Splits a sandbox period at UTC midnights into hours per day, dropping any
// part before `since`.
export function sandboxHoursByDay(
  startedAt: Date,
  endedAt: Date,
  since: Date,
): Array<{ day: string; hours: number }> {
  const result: Array<{ day: string; hours: number }> = [];
  let from = Math.max(startedAt.getTime(), since.getTime());
  const to = endedAt.getTime();
  while (from < to) {
    const nextMidnight = (Math.floor(from / dayMs) + 1) * dayMs;
    const until = Math.min(to, nextMidnight);
    result.push({
      day: new Date(from).toISOString().slice(0, 10),
      hours: (until - from) / 3_600_000,
    });
    from = until;
  }
  return result;
}

const nonAutomationSources = new Set([
  "deleted_automation",
  "investigations",
  "pull_requests",
  "tag_mode",
]);

export function usageSources(
  points: Array<Pick<UsageHistoryPoint, "source">>,
  names: Array<{ id: string; name: string }>,
): Record<string, UsageSource> {
  const nameById = new Map(names.map((row) => [row.id, row.name]));
  const sources: Record<string, UsageSource> = {};
  for (const { source } of points) {
    if (sources[source]) continue;
    if (nonAutomationSources.has(source)) {
      sources[source] = { kind: source as Exclude<UsageSource["kind"], "automation"> };
      continue;
    }
    const name = nameById.get(source);
    sources[source] = name === undefined
      ? { kind: "deleted_automation" }
      : { automationId: source, kind: "automation", name };
  }
  return sources;
}
