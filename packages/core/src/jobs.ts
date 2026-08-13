import { PgBoss } from "pg-boss";
import { z } from "zod";
import { databaseConnectionString } from "./db/client.js";
import { investigationRequestSchema } from "./investigations/input.js";
import { agentPrModeSchema } from "./agents/config.js";
import { issueEvidenceSchema, issueSeveritySchema } from "./investigations/report.js";

export const workerHealthQueue = "responder-worker-health";
export const investigationQueue = "responder-investigations";

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
  issue: z.object({
    id: z.uuid(),
    title: z.string().min(1),
    description: z.string().min(1),
    severity: issueSeveritySchema,
    remediation: z.string().min(1),
    evidence: z.array(issueEvidenceSchema),
  }),
  queuedAt: z.iso.datetime(),
  remediationRequestId: z.uuid(),
  runtimeProfileId: z.uuid(),
});

export type RemediationJob = z.infer<typeof remediationJobSchema>;
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
  ]);
}
