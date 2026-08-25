import { PgBoss } from "pg-boss";
import { z } from "zod";
import { databaseConnectionString } from "./db/client.js";
import { investigationRequestSchema } from "./investigations/input.js";
import { agentPrModeSchema } from "./agents/config.js";
import {
  issueEvidenceSchema,
  issueRemediationSubmissionSchema,
  issueSeveritySchema,
  issueTimelineEntrySchema,
} from "./investigations/report.js";

export const workerHealthQueue = "responder-worker-health";
export const investigationQueue = "responder-investigations";
// Version queue names when introducing a policy: createQueue intentionally
// leaves an existing queue's policy unchanged.
export const linearTicketQueue = "responder-linear-tickets-v2";
export const remediationQueue = "responder-remediations-v2";
export const pullRequestReviewQueue = "responder-pull-request-reviews-v1";

export const investigationHeartbeatSeconds = 60;

export const workerHealthJobSchema = z.object({
  marker: z.string().min(1),
  requestedAt: z.iso.datetime(),
});

export type WorkerHealthJob = z.infer<typeof workerHealthJobSchema>;

const runtimeAgentJobConfigSchema = z.object({
    agentId: z.uuid(),
    id: z.uuid(),
    model: z.string().min(1),
    organizationId: z.uuid(),
    prMode: agentPrModeSchema,
    prompt: z.string(),
});

const remediationIssueSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  description: z.string().min(1),
  rootCause: z.string().default(""),
  timeline: z.array(issueTimelineEntrySchema).default([]),
  severity: issueSeveritySchema,
  remediation: z.string().min(1),
  evidence: z.array(issueEvidenceSchema),
});

export const investigationJobSchema = z.object({
  kind: z.literal("investigation"),
  config: runtimeAgentJobConfigSchema,
  investigationId: z.uuid(),
  queuedAt: z.iso.datetime(),
  request: investigationRequestSchema,
  replay: z.boolean().default(false),
  runtimeProfileId: z.uuid(),
});

export type InvestigationJob = z.infer<typeof investigationJobSchema>;

export const remediationJobSchema = z.object({
  kind: z.literal("remediation"),
  config: runtimeAgentJobConfigSchema,
  investigationId: z.uuid(),
  issue: remediationIssueSchema,
  selectedRemediation: issueRemediationSubmissionSchema.optional(),
  queuedAt: z.iso.datetime(),
  remediationRequestId: z.uuid(),
  runtimeProfileId: z.uuid(),
});

export type RemediationJob = z.infer<typeof remediationJobSchema>;

export const pullRequestReviewJobSchema = z.object({
  kind: z.literal("pull_request_review"),
  config: runtimeAgentJobConfigSchema,
  installationId: z.number().int().positive(),
  investigationId: z.uuid(),
  issue: remediationIssueSchema,
  pullRequest: z.object({
    branch: z.string().min(1),
    number: z.number().int().positive(),
    repository: z.string().min(1),
  }),
  queuedAt: z.iso.datetime(),
  requestId: z.uuid(),
  runtimeProfileId: z.uuid(),
});

export type PullRequestReviewJob = z.infer<
  typeof pullRequestReviewJobSchema
>;
export const linearTicketJobSchema = z.object({
  kind: z.literal("linear_ticket"),
  config: runtimeAgentJobConfigSchema,
  investigationId: z.uuid(),
  queuedAt: z.iso.datetime(),
  requestId: z.uuid(),
});
export type LinearTicketJob = z.infer<typeof linearTicketJobSchema>;
export const responderJobSchema = z.discriminatedUnion("kind", [
  investigationJobSchema,
  remediationJobSchema,
]);
export type ResponderJob = z.infer<typeof responderJobSchema>;

export function createJobBoss(
  environment: NodeJS.ProcessEnv = process.env,
): PgBoss {
  const connectionString = databaseConnectionString(environment);
  if (!connectionString) {
    throw new Error("Database configuration is required for background jobs");
  }

  return new PgBoss({
    application_name: "responder-worker",
    connectionString,
    max: 4,
    useListenNotify: true,
  });
}

interface LegacyHeartbeatMigrationOptions {
  handoffWaitMs: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

// One-time queue migration for jobs created before heartbeat support.
// Remove this function and its worker startup call after 2026-09-02, when
// pg-boss's seven-day retention guarantees no pre-rollout job can remain.
export async function migrateLegacyInvestigationHeartbeats(
  boss: PgBoss,
  options: LegacyHeartbeatMigrationOptions,
): Promise<void> {
  const database = boss.getDb();
  const now = options.now ?? Date.now;
  const waitFor = options.wait ?? wait;
  const deadline = now() + options.handoffWaitMs;

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
    if (active.rows.length === 0 || now() >= deadline) return;
    await waitFor(1_000);
  }
}

export async function prepareWorkerQueues(boss: PgBoss): Promise<void> {
  await Promise.all([
    boss.createQueue(workerHealthQueue, {
      deleteAfterSeconds: 86_400,
      expireInSeconds: 60,
      notify: true,
      retryBackoff: true,
      retryDelay: 5,
      retryLimit: 3,
    }),
    boss.createQueue(investigationQueue, {
      deleteAfterSeconds: 604_800,
      expireInSeconds: 3_600,
      heartbeatSeconds: investigationHeartbeatSeconds,
      notify: true,
      retryBackoff: true,
      retryDelay: 30,
      retryLimit: 2,
    }),
    boss.createQueue(remediationQueue, {
      deleteAfterSeconds: 604_800,
      expireInSeconds: 3_600,
      notify: true,
      policy: "exclusive",
      // Retrying the agent could repeat PR side effects. Terminal writes are
      // independent of monitoring, and a worker sweep reconciles abandoned rows.
      retryLimit: 0,
    }),
    boss.createQueue(pullRequestReviewQueue, {
      deleteAfterSeconds: 604_800,
      expireInSeconds: 3_600,
      notify: true,
      // Preserve every comment event while running only one follow-up per PR.
      // Redundant queued passes are cheap because they exit when no threads remain.
      policy: "key_strict_fifo",
      retryBackoff: true,
      retryDelay: 30,
      // Thread replies carry stable markers, so partial publication can resume
      // without posting duplicate replies.
      retryLimit: 3,
    }),
    boss.createQueue(linearTicketQueue, {
      deleteAfterSeconds: 604_800,
      expireInSeconds: 900,
      notify: true,
      // singletonKey is enforced only by pg-boss queue policies that opt into
      // singleton semantics. Exclusive keeps one queued or active job per
      // Linear request key while allowing unrelated requests to run together.
      policy: "exclusive",
      retryBackoff: true,
      retryDelay: 60,
      retryLimit: 5,
    }),
  ]);
  // createQueue leaves an existing queue unchanged. Reconcile the heartbeat
  // separately so future jobs use it on the durable production queue. Active
  // jobs from the old task are failed back to the queue by pg-boss shutdown.
  await boss.updateQueue(investigationQueue, {
    heartbeatSeconds: investigationHeartbeatSeconds,
  });
}
