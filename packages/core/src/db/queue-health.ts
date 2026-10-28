import { sql } from "drizzle-orm";
import { automationRunQueue, legacyAutomationRunQueue } from "../jobs.js";
import { getDatabase } from "./client.js";

// Counts that show whether queued work is being taken and finished. They are
// read from the database, so they stay correct when the worker is stuck.
export type QueueHealth = {
  automationRuns: {
    // Runs that finished in the last 15 minutes, by final status.
    finished: Record<string, number>;
    // Running runs whose worker lease expired more than two minutes ago.
    leaseExpired: number;
    oldestPendingSeconds: number;
    // Unfinished runs older than five minutes with no queued or active job.
    // Nothing will start them again.
    orphaned: number;
    pending: number;
  };
  jobs: Array<{
    // Jobs that failed in the last 15 minutes after their last retry.
    failed: number;
    // Seconds since a job in this queue last completed, if one did today.
    lastCompletedSeconds: number | null;
    oldestQueuedSeconds: number;
    queue: string;
    queued: number;
  }>;
};

const finishedWindow = sql`interval '15 minutes'`;
const leaseGrace = sql`interval '2 minutes'`;

export async function readQueueHealth(): Promise<QueueHealth> {
  const database = getDatabase();
  const runQueues = [automationRunQueue, legacyAutomationRunQueue];
  const [runs, finished, jobs] = await Promise.all([
    database.execute<{
      lease_expired: string;
      oldest_pending_seconds: string | null;
      orphaned: string;
      pending: string;
    }>(sql`
      select
        count(*) filter (where r.status = 'pending') as pending,
        extract(epoch from now() - min(r.created_at) filter (where r.status = 'pending'))
          as oldest_pending_seconds,
        count(*) filter (
          where r.status = 'running' and r.lease_expires_at < now() - ${leaseGrace}
        ) as lease_expired,
        count(*) filter (
          where r.created_at < now() - interval '5 minutes'
            and (r.status = 'pending' or r.lease_expires_at is null
              or r.lease_expires_at < now() - ${leaseGrace})
            and not exists (
              select 1 from pgboss.job j
              where j.name in (${sql.join(runQueues.map((queue) => sql`${queue}`), sql`, `)})
                and j.data->>'runId' = r.id::text
                and j.state in ('created', 'retry', 'active')
            )
        ) as orphaned
      from automation_runs r
      where r.status in ('pending', 'running')
    `),
    database.execute<{ count: string; status: string }>(sql`
      select status, count(*) as count
      from automation_runs
      where completed_at > now() - ${finishedWindow}
      group by status
    `),
    database.execute<{
      failed: string;
      last_completed_seconds: string | null;
      name: string;
      oldest_queued_seconds: string | null;
      queued: string;
    }>(sql`
      select
        name,
        count(*) filter (where state in ('created', 'retry') and start_after <= now()) as queued,
        extract(epoch from now() - min(start_after) filter (
          where state in ('created', 'retry') and start_after <= now()
        )) as oldest_queued_seconds,
        count(*) filter (where state = 'failed' and completed_on > now() - ${finishedWindow})
          as failed,
        extract(epoch from now() - max(completed_on) filter (where state = 'completed'))
          as last_completed_seconds
      from pgboss.job
      where completed_on is null or completed_on > now() - interval '1 day'
      group by name
    `),
  ]);

  const run = runs.rows[0];
  return {
    automationRuns: {
      finished: Object.fromEntries(
        finished.rows.map((row) => [row.status, Number(row.count)]),
      ),
      leaseExpired: Number(run?.lease_expired ?? 0),
      oldestPendingSeconds: Number(run?.oldest_pending_seconds ?? 0),
      orphaned: Number(run?.orphaned ?? 0),
      pending: Number(run?.pending ?? 0),
    },
    jobs: jobs.rows.map((row) => ({
      failed: Number(row.failed),
      lastCompletedSeconds:
        row.last_completed_seconds == null ? null : Number(row.last_completed_seconds),
      oldestQueuedSeconds: Number(row.oldest_queued_seconds ?? 0),
      queue: row.name,
      queued: Number(row.queued),
    })),
  };
}
