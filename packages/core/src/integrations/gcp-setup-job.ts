import { randomUUID } from "node:crypto";
import { z } from "zod";
import { captureAnalyticsEvent } from "../analytics.js";
import {
  decryptCredentials,
  encryptCredentials,
} from "../credentials/encryption.js";
import {
  getOrganizationIntegrationAccount,
  updateIntegrationAccountSetup,
} from "../db/integrations.js";
import type { GcpProjectSetupJob } from "../jobs.js";
import { gcpConnectionCredentialsSchema, verifyGcpProject } from "./gcp.js";
import {
  advanceGcpProjectSetup,
  GcpSetupError,
  revokeGcpOAuthToken,
} from "./gcp-setup.js";

export const GCP_SETUP_ROUND_DELAY_SECONDS = 3;
// Google documents that IAM changes usually apply within two minutes and can
// take up to seven. The customer's access token lasts an hour.
const GCP_SETUP_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_CONSECUTIVE_ROUND_FAILURES = 5;

export const gcpSetupSteps = [
  "starting",
  "enabling_apis",
  "creating_identity_pool",
  "creating_identity_provider",
  "granting_access",
  "waiting_for_google",
] as const;

export const gcpSetupStateSchema = z.object({
  message: z.string().optional(),
  round: z.number().int().nonnegative().default(0),
  runId: z.uuid(),
  startedAt: z.iso.datetime(),
  status: z.enum(["running", "succeeded", "failed"]),
  step: z.enum(gcpSetupSteps),
  updatedAt: z.iso.datetime(),
});

export type GcpSetupState = z.infer<typeof gcpSetupStateSchema>;

export function startGcpProjectSetup(input: {
  accessToken: string;
  integrationAccountId: string;
  now?: Date;
  organizationId: string;
  userId: string;
}): { job: GcpProjectSetupJob; setup: GcpSetupState } {
  const now = input.now ?? new Date();
  const runId = randomUUID();
  return {
    job: {
      kind: "gcp_project_setup",
      deadline: new Date(now.getTime() + GCP_SETUP_TIMEOUT_MS).toISOString(),
      encryptedAccessToken: encryptCredentials({ accessToken: input.accessToken }),
      failures: 0,
      integrationAccountId: input.integrationAccountId,
      organizationId: input.organizationId,
      queuedAt: now.toISOString(),
      round: 0,
      runId,
      userId: input.userId,
    },
    setup: {
      round: 0,
      runId,
      startedAt: now.toISOString(),
      status: "running",
      step: "starting",
      updatedAt: now.toISOString(),
    },
  };
}

export interface GcpProjectSetupJobDependencies {
  advance: typeof advanceGcpProjectSetup;
  enqueue: (job: GcpProjectSetupJob, delaySeconds: number) => Promise<void>;
  now: () => Date;
  revoke: (accessToken: string) => Promise<void>;
  verify: typeof verifyGcpProject;
}

function logSetupEvent(
  event: string,
  job: GcpProjectSetupJob,
  details: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({
    event,
    integrationAccountId: job.integrationAccountId,
    organizationId: job.organizationId,
    runId: job.runId,
    ...details,
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one setup round and queues the next one. Progress lives in the
 * account's `setup` metadata so the dialog and the settings tile can show it
 * without the browser driving the work.
 */
export async function processGcpProjectSetupJob(
  job: GcpProjectSetupJob,
  dependencies: Pick<GcpProjectSetupJobDependencies, "enqueue"> &
    Partial<GcpProjectSetupJobDependencies>,
): Promise<"failed" | "running" | "succeeded" | "superseded"> {
  const advance = dependencies.advance ?? advanceGcpProjectSetup;
  const verify = dependencies.verify ?? verifyGcpProject;
  const revoke = dependencies.revoke ?? ((token) => revokeGcpOAuthToken(token));
  const now = dependencies.now ?? (() => new Date());
  const { accessToken } = decryptCredentials<{ accessToken: string }>(
    job.encryptedAccessToken,
  );

  const account = await getOrganizationIntegrationAccount({
    integrationAccountId: job.integrationAccountId,
    organizationId: job.organizationId,
    provider: "gcp",
  });
  const current = gcpSetupStateSchema.safeParse(account?.metadata.setup);
  // Revoking a token can revoke the user's whole grant, so only the run that
  // still owns the setup revokes. A superseded token expires within an hour.
  if (
    !account?.encryptedCredentials ||
    !current.success ||
    current.data.runId !== job.runId ||
    current.data.round !== job.round ||
    current.data.status !== "running"
  ) {
    logSetupEvent("gcp_setup_superseded", job);
    return "superseded";
  }

  const record = (
    update: Partial<GcpSetupState>,
    status?: "connected" | "error",
  ) =>
    updateIntegrationAccountSetup({
      integrationAccountId: job.integrationAccountId,
      owner: { round: job.round, runId: job.runId },
      setup: {
        ...current.data,
        ...update,
        round: job.round + 1,
        updatedAt: now().toISOString(),
      },
      status,
    });
  const queueNextRound = (failures: number) =>
    dependencies.enqueue(
      { ...job, failures, queuedAt: now().toISOString(), round: job.round + 1 },
      GCP_SETUP_ROUND_DELAY_SECONDS,
    );
  const fail = async (message: string) => {
    const owned = await record(
      { message, status: "failed" },
      // A reconnect that fails leaves a working connection untouched.
      account.status === "connected" ? undefined : "error",
    );
    if (!owned) return "superseded" as const;
    await revoke(accessToken);
    logSetupEvent("gcp_setup_failed", job, { message });
    return "failed" as const;
  };

  if (now().getTime() > Date.parse(job.deadline)) {
    return fail(
      "Google did not finish applying the new access in time. Reconnect the project to try again.",
    );
  }

  const connection = gcpConnectionCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
  );
  let step: GcpSetupState["step"] | null = null;
  try {
    const progress = await advance({ accessToken, connection });
    if (progress.status === "pending") {
      step = progress.step;
    } else {
      try {
        await verify(connection);
      } catch (error) {
        // Google applies new IAM bindings and federation settings gradually.
        logSetupEvent("gcp_setup_verification_pending", job, {
          error: errorMessage(error),
        });
        step = "waiting_for_google";
      }
    }
  } catch (error) {
    if (error instanceof GcpSetupError) return fail(error.message);
    const failures = job.failures + 1;
    logSetupEvent("gcp_setup_round_failed", job, {
      error: errorMessage(error),
      failures,
    });
    if (failures >= MAX_CONSECUTIVE_ROUND_FAILURES) {
      return fail("Google Cloud setup failed. Reconnect the project to try again.");
    }
    if (!(await record({}))) return "superseded";
    await queueNextRound(failures);
    return "running";
  }

  if (!step) {
    if (!(await record({ status: "succeeded" }, "connected"))) return "superseded";
    await revoke(accessToken);
    await captureAnalyticsEvent({
      distinctId: job.userId,
      event: "integration connected",
      organizationId: job.organizationId,
      properties: {
        integration_account_id: job.integrationAccountId,
        provider: "gcp",
      },
    });
    logSetupEvent("gcp_setup_succeeded", job);
    return "succeeded";
  }

  if (!(await record({ step }))) {
    logSetupEvent("gcp_setup_superseded", job);
    return "superseded";
  }
  await queueNextRound(0);
  return "running";
}
