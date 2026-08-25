import { investigationQueue } from "@responder/core/jobs";

const heartbeatSeconds = 60;

interface LegacyHeartbeatBoss {
  emit(event: "error", error: Error): boolean;
  getDb(): {
    executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  };
  touch(name: string, id: string): Promise<unknown>;
}

// Rollout bridge for jobs fetched before responder-investigations stored a
// heartbeat. It is dormant for every job created after that queue update and
// can be removed once no pre-rollout jobs remain in pg-boss retention.
export async function maintainLegacyInvestigationHeartbeat(
  boss: LegacyHeartbeatBoss,
  job: { heartbeatSeconds: number | null; id: string },
): Promise<() => void> {
  if (job.heartbeatSeconds !== null) return () => undefined;

  const adopted = await boss.getDb().executeSql(
    `UPDATE pgboss.job
     SET heartbeat_seconds = $3,
         heartbeat_on = now()
     WHERE name = $1
       AND id = $2::uuid
       AND state = 'active'
       AND heartbeat_seconds IS NULL
     RETURNING id`,
    [investigationQueue, job.id, heartbeatSeconds],
  );
  if (adopted.rows.length === 0) return () => undefined;

  const timer = setInterval(() => {
    void boss.touch(investigationQueue, job.id).catch((error: unknown) => {
      boss.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }, heartbeatSeconds * 500);
  timer.unref();
  return () => clearInterval(timer);
}
