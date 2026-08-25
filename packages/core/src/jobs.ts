import { PgBoss } from "pg-boss";
import { z } from "zod";
import { databaseConnectionString } from "./db/client.js";
import { investigationRequestSchema } from "./investigations/input.js";
import { agentPrModeSchema } from "./agents/config.js";
import {
  issueEvidenceSchema,
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
      // Keep one active follow-up per PR while retaining later comment events.
      // Redundant queued passes are cheap because they exit when no threads remain.
      policy: "singleton",
      // A retry could duplicate review replies or race a newer PR head. A new
      // root review comment will enqueue another pass.
      retryLimit: 0,
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
}
