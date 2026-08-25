import {
  investigationHeartbeatSeconds,
  investigationQueue,
} from "@responder/core/jobs";
import { legacyHeartbeatAdoptionGraceMs } from "./shutdown-policy.js";

const pollIntervalMs = 1_000;

interface LegacyHeartbeatMigrationBoss {
  getDb(): {
    executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  };
}

interface LegacyHeartbeatMigrationOptions {
  graceMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

// One-time rollout migration for jobs created before heartbeat support.
// Remove this module and startup call after 2026-09-02, when pg-boss's
// seven-day job retention guarantees no pre-rollout job can remain.
export async function migrateLegacyInvestigationHeartbeats(
  boss: LegacyHeartbeatMigrationBoss,
  options: LegacyHeartbeatMigrationOptions = {},
): Promise<void> {
  const database = boss.getDb();
  const now = options.now ?? Date.now;
  const waitFor = options.wait ?? wait;
  const deadline = now() + (options.graceMs ?? legacyHeartbeatAdoptionGraceMs);

  while (true) {
    await database.executeSql(
      `UPDATE pgboss.job
       SET heartbeat_seconds = $2
       WHERE name = $1
         AND state IN ('created', 'retry')
         AND heartbeat_seconds IS NULL`,
      [investigationQueue, investigationHeartbeatSeconds],
    );
    const active = await database.executeSql(
      `SELECT id
       FROM pgboss.job
       WHERE name = $1
         AND state = 'active'
         AND heartbeat_seconds IS NULL
       LIMIT 1`,
      [investigationQueue],
    );
    if (active.rows.length === 0) return;
    if (now() < deadline) {
      await waitFor(pollIntervalMs);
      continue;
    }

    // The previous ECS task has exhausted its stop timeout. Any legacy active
    // row is abandoned, so initialize its heartbeat for pg-boss supervision.
    await database.executeSql(
      `UPDATE pgboss.job
       SET heartbeat_seconds = $2,
           heartbeat_on = now()
     WHERE name = $1
       AND state = 'active'
       AND heartbeat_seconds IS NULL`,
      [investigationQueue, investigationHeartbeatSeconds],
    );
    return;
  }
}
