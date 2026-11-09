import { Hono } from "hono";
import { z } from "zod";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  AwsAccountStreamsElsewhereError,
  awsLogSubscriptionAccountsByRegion,
  deleteAwsLogSubscription as deleteAwsLogSubscriptionRow,
  findDueAwsLogSubscriptions,
  listAwsLogSubscriptions,
  markAwsLogSubscriptionActive,
  markAwsLogSubscriptionFailed,
  markAwsLogSubscriptionRemovalFailed,
  setAwsLogSubscriptionRegions,
  type AwsLogSubscription,
} from "../../../../packages/core/src/db/aws-log-subscriptions.js";
import { getOrganizationIntegrationAccount } from "../../../../packages/core/src/db/integrations.js";
import {
  awsConnectionCredentialsSchema,
  createAwsCloudFormationTemplateUrl,
  parseSnsTopicArn,
  type AwsConnectionCredentials,
} from "../../../../packages/core/src/integrations/aws.js";
import {
  assumeAwsLogSubscriptionRole,
  AwsLogSubscriptionRoleUnavailableError,
  awsLogSubscriptionConfig,
  awsLogSubscriptionFilterPattern,
  deleteAwsLogSubscription,
  describeAwsLogSubscriptionError,
  putAwsLogDestinationPolicy,
  putAwsLogSubscription,
  type AwsLogSubscriptionConfig,
  type AwsTemporaryCredentials,
} from "../../../../packages/core/src/integrations/aws-log-subscriptions.js";
import { awsRegistrationTopicArn } from "../../../../packages/core/src/integrations/aws-registration.js";
import { getActiveTenant } from "../tenant.js";

// Keeps each AWS connection's CloudWatch Logs subscriptions (ADR 0015) in
// line with the regions its workspace chose. Runs only in the API, the one
// service allowed to assume the log subscription broker.

export interface AwsLogSubscriptionDependencies {
  assume: (connection: AwsConnectionCredentials, config: AwsLogSubscriptionConfig) => Promise<AwsTemporaryCredentials>;
  config: () => AwsLogSubscriptionConfig | null;
  connection: (input: { integrationAccountId: string; organizationId: string }) => Promise<{
    credentials: AwsConnectionCredentials | null;
    status: string;
  } | null>;
  deleteRow: typeof deleteAwsLogSubscriptionRow;
  deleteSubscription: typeof deleteAwsLogSubscription;
  due: typeof findDueAwsLogSubscriptions;
  list: typeof listAwsLogSubscriptions;
  markActive: typeof markAwsLogSubscriptionActive;
  markFailed: typeof markAwsLogSubscriptionFailed;
  markRemovalFailed: typeof markAwsLogSubscriptionRemovalFailed;
  now: () => number;
  putDestinationPolicy: typeof putAwsLogDestinationPolicy;
  putSubscription: typeof putAwsLogSubscription;
  regionAccounts: typeof awsLogSubscriptionAccountsByRegion;
  setRegions: typeof setAwsLogSubscriptionRegions;
  templateUrl: () => Promise<string | null>;
  topicArn: () => string | null;
}

async function loadConnection(input: { integrationAccountId: string; organizationId: string }) {
  const account = await getOrganizationIntegrationAccount({ ...input, provider: "aws" });
  if (!account) return null;
  let credentials: AwsConnectionCredentials | null = null;
  if (account.encryptedCredentials) {
    try {
      const parsed = awsConnectionCredentialsSchema.safeParse(
        decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
      );
      credentials = parsed.success ? parsed.data : null;
    } catch {
      credentials = null;
    }
  }
  return { credentials, status: account.status };
}

export const defaultAwsLogSubscriptionDependencies: AwsLogSubscriptionDependencies = {
  assume: (connection, config) => assumeAwsLogSubscriptionRole(connection, { config }),
  config: () => awsLogSubscriptionConfig(),
  connection: loadConnection,
  deleteRow: deleteAwsLogSubscriptionRow,
  deleteSubscription: deleteAwsLogSubscription,
  due: findDueAwsLogSubscriptions,
  list: listAwsLogSubscriptions,
  markActive: markAwsLogSubscriptionActive,
  markFailed: markAwsLogSubscriptionFailed,
  markRemovalFailed: markAwsLogSubscriptionRemovalFailed,
  now: Date.now,
  putDestinationPolicy: putAwsLogDestinationPolicy,
  putSubscription: putAwsLogSubscription,
  regionAccounts: awsLogSubscriptionAccountsByRegion,
  setRegions: setAwsLogSubscriptionRegions,
  templateUrl: () => createAwsCloudFormationTemplateUrl(),
  topicArn: () => awsRegistrationTopicArn(),
};

const retryFailedAfterMs = 10 * 60_000;
// Destination policies are rewritten when their account list changes, and
// at least this often, so a policy changed by hand is put back.
const destinationRefreshMs = 15 * 60_000;

function log(fields: Record<string, unknown>): void {
  const write = fields.outcome === "failed" ? console.warn : console.info;
  write(JSON.stringify({ event: "aws_log_subscription", ...fields }));
}

export function createAwsLogSubscriptionManager(deps: AwsLogSubscriptionDependencies = defaultAwsLogSubscriptionDependencies) {
  const applied = new Map<string, { at: number; policy: string }>();

  // Makes each region's destination accept exactly the AWS accounts that
  // subscribe there. A region whose list did not change is skipped until the
  // refresh interval passes.
  async function syncDestinations(config: AwsLogSubscriptionConfig, regions: string[] = config.regions): Promise<void> {
    const accounts = await deps.regionAccounts();
    for (const region of regions) {
      if (!config.regions.includes(region)) continue;
      const accountIds = accounts.get(region) ?? [];
      const key = accountIds.join(",");
      const previous = applied.get(region);
      if (previous && previous.policy === key && deps.now() - previous.at < destinationRefreshMs) continue;
      try {
        await deps.putDestinationPolicy({ accountIds, config, region });
        applied.set(region, { at: deps.now(), policy: key });
      } catch (error) {
        applied.delete(region);
        log({ error: error instanceof Error ? error.message : String(error), outcome: "failed", region, stage: "destination_policy" });
      }
    }
  }

  // Applies or removes the given subscriptions, one AWS account at a time.
  async function process(config: AwsLogSubscriptionConfig, rows: AwsLogSubscription[]): Promise<void> {
    const byConnection = new Map<string, AwsLogSubscription[]>();
    for (const row of rows) byConnection.set(row.integrationAccountId, [...(byConnection.get(row.integrationAccountId) ?? []), row]);
    for (const group of byConnection.values()) {
      const first = group[0]!;
      const connection = await deps.connection({ integrationAccountId: first.integrationAccountId, organizationId: first.organizationId });
      let credentials: AwsTemporaryCredentials | null = null;
      let assumeError: unknown = null;
      if (connection?.credentials) {
        try {
          credentials = await deps.assume(connection.credentials, config);
        } catch (error) {
          assumeError = error;
        }
      } else {
        assumeError = new AwsLogSubscriptionRoleUnavailableError(new Error("The AWS connection has no credentials"));
      }
      for (const row of group) {
        const base = { awsAccountId: row.awsAccountId, organizationId: row.organizationId, region: row.region };
        if (row.status === "removing") {
          if (!credentials) {
            // Without the role the policy cannot be deleted from here. The
            // destination stops accepting the account once the row is gone.
            await deps.deleteRow(row.id);
            log({ ...base, outcome: "forgotten", stage: "remove" });
            continue;
          }
          try {
            await deps.deleteSubscription({ credentials, region: row.region });
            await deps.deleteRow(row.id);
            log({ ...base, outcome: "removed", stage: "remove" });
          } catch (error) {
            const described = describeAwsLogSubscriptionError(error, row.region);
            await deps.markRemovalFailed(row.id, described.message);
            log({ ...base, outcome: "failed", problem: described.problem, stage: "remove" });
          }
          continue;
        }
        if (!credentials) {
          const described = describeAwsLogSubscriptionError(assumeError, row.region);
          await deps.markFailed(row.id, described.message);
          log({ ...base, outcome: "failed", problem: described.problem, stage: "assume" });
          continue;
        }
        try {
          await deps.putSubscription({ config, credentials, filterPattern: awsLogSubscriptionFilterPattern, region: row.region });
          await deps.markActive(row.id, awsLogSubscriptionFilterPattern);
          log({ ...base, outcome: "applied", stage: "apply" });
        } catch (error) {
          const described = describeAwsLogSubscriptionError(error, row.region);
          await deps.markFailed(row.id, described.message);
          log({ ...base, outcome: "failed", problem: described.problem, stage: "apply" });
        }
      }
    }
  }

  // One pass: the destinations first, since CloudWatch Logs checks a
  // destination's policy when a subscription is created, then due work.
  async function reconcile(): Promise<void> {
    const config = deps.config();
    if (!config) return;
    await syncDestinations(config);
    const rows = await deps.due({
      filterPattern: awsLogSubscriptionFilterPattern,
      limit: 100,
      retryFailedBefore: new Date(deps.now() - retryFailedAfterMs),
    });
    await process(config, rows);
  }

  // Applies a connection's changes now, so the admin sees the outcome.
  async function applyNow(config: AwsLogSubscriptionConfig, rows: AwsLogSubscription[]): Promise<void> {
    const regions = [...new Set(rows.map((row) => row.region))];
    await syncDestinations(config, regions);
    // A changed list was put above; force the regions that this change touches.
    await process(config, rows.filter((row) => row.status !== "active" || row.filterPattern !== awsLogSubscriptionFilterPattern));
  }

  // Deletes a removed connection's policies, best effort. Its rows are gone
  // with the connection, so the next destination sync stops accepting the
  // account even when a policy could not be deleted.
  async function removeForConnection(input: {
    credentials: AwsConnectionCredentials;
    regions: string[];
  }): Promise<void> {
    const config = deps.config();
    if (!config || input.regions.length === 0) return;
    let credentials: AwsTemporaryCredentials;
    try {
      credentials = await deps.assume(input.credentials, config);
    } catch (error) {
      log({ awsAccountId: input.credentials.accountId, outcome: "failed", problem: describeAwsLogSubscriptionError(error, "").problem, stage: "disconnect" });
      return;
    }
    for (const region of input.regions) {
      try {
        await deps.deleteSubscription({ credentials, region });
        log({ awsAccountId: input.credentials.accountId, outcome: "removed", region, stage: "disconnect" });
      } catch (error) {
        log({ awsAccountId: input.credentials.accountId, outcome: "failed", problem: describeAwsLogSubscriptionError(error, region).problem, region, stage: "disconnect" });
      }
    }
    await syncDestinations(config, input.regions);
  }

  return { applyNow, reconcile, removeForConnection, syncDestinations };
}

// --- Scheduler ------------------------------------------------------------

const pollIntervalMs = 60_000;
let poller: NodeJS.Timeout | undefined;
let pass: Promise<void> | undefined;
const scheduledManager = createAwsLogSubscriptionManager();

function runPass(): Promise<void> {
  if (pass) return pass;
  pass = scheduledManager.reconcile()
    .catch((error: unknown) => {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "aws_log_subscription_pass_failed",
      }));
    })
    .finally(() => {
      pass = undefined;
    });
  return pass;
}

export function startAwsLogSubscriptionScheduler(): void {
  if (poller || !awsLogSubscriptionConfig()) return;
  void runPass();
  poller = setInterval(() => void runPass(), pollIntervalMs);
  poller.unref();
}

export async function stopAwsLogSubscriptionScheduler(): Promise<void> {
  if (poller) clearInterval(poller);
  poller = undefined;
  await pass;
}

// --- Routes ---------------------------------------------------------------

const regionsSchema = z.object({ regions: z.array(z.string()).max(40) });

function isWorkspaceAdmin(role: string): boolean {
  return role.split(",").some((value) => ["owner", "admin"].includes(value.trim()));
}

export const AWS_STACK_NAME = "ResponderInvestigationAccess";

// How an admin adds ResponderLogSubscriptionRole to a stack created before
// it existed: one update that keeps every other parameter.
export function awsStackUpdateCommand(input: {
  logSubscriptionPrincipalArn: string;
  region: string | null;
  templateUrl: string | null;
}): string {
  return [
    "aws cloudformation update-stack",
    ...(input.region ? [`--region ${input.region}`] : []),
    `--stack-name ${AWS_STACK_NAME}`,
    input.templateUrl ? `--template-url '${input.templateUrl}'` : "--template-body file://responder-aws-access.yaml",
    "--capabilities CAPABILITY_NAMED_IAM",
    "--parameters",
    "ParameterKey=ResponderPrincipalArn,UsePreviousValue=true",
    "ParameterKey=ExternalId,UsePreviousValue=true",
    "ParameterKey=RegistrationTopicArn,UsePreviousValue=true",
    `ParameterKey=LogSubscriptionPrincipalArn,ParameterValue=${input.logSubscriptionPrincipalArn}`,
  ].join(" ");
}

export function createAwsLogSubscriptionRoutes(deps: AwsLogSubscriptionDependencies = defaultAwsLogSubscriptionDependencies) {
  const manager = createAwsLogSubscriptionManager(deps);

  async function present(input: {
    config: AwsLogSubscriptionConfig;
    integrationAccountId: string;
    organizationId: string;
  }) {
    const subscriptions = await deps.list(input);
    const roleMissing = subscriptions.some((row) => row.status === "failed" && row.lastError?.includes("ResponderLogSubscriptionRole"));
    const topicArn = deps.topicArn();
    const templateUrl = roleMissing ? await deps.templateUrl().catch(() => null) : null;
    return {
      available: true,
      filter: "Error lines only: ERROR, FATAL, and CRITICAL lines, exceptions, tracebacks, and panics.",
      regions: input.config.regions,
      stackUpdate: roleMissing
        ? {
            command: awsStackUpdateCommand({
              logSubscriptionPrincipalArn: input.config.principalArn,
              region: topicArn ? parseSnsTopicArn(topicArn)?.region ?? null : null,
              templateUrl,
            }),
            logSubscriptionPrincipalArn: input.config.principalArn,
            stackName: AWS_STACK_NAME,
            templateUrl,
          }
        : null,
      subscriptions: subscriptions.map((row) => ({
        appliedAt: row.appliedAt?.toISOString() ?? null,
        lastError: row.lastError,
        region: row.region,
        status: row.status,
      })),
    };
  }

  return new Hono()
    .get("/:integrationAccountId", async (context) => {
      const tenant = await getActiveTenant(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      const config = deps.config();
      if (!config) return context.json({ available: false, regions: [], stackUpdate: null, subscriptions: [] });
      const input = { integrationAccountId: context.req.param("integrationAccountId"), organizationId: tenant.organizationId };
      if (!z.uuid().safeParse(input.integrationAccountId).success || !(await deps.connection(input))) {
        return context.json({ error: "AWS connection not found" }, 404);
      }
      return context.json(await present({ config, ...input }));
    })
    .put("/:integrationAccountId", async (context) => {
      const tenant = await getActiveTenant(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      if (!isWorkspaceAdmin(tenant.role)) {
        return context.json({ error: "Only workspace owners and admins can change log streaming" }, 403);
      }
      const config = deps.config();
      if (!config) return context.json({ error: "Log streaming is not available here" }, 404);
      const input = { integrationAccountId: context.req.param("integrationAccountId"), organizationId: tenant.organizationId };
      if (!z.uuid().safeParse(input.integrationAccountId).success) return context.json({ error: "AWS connection not found" }, 404);
      const body = regionsSchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success || body.data.regions.some((region) => !config.regions.includes(region))) {
        return context.json({ error: "Choose regions from the list" }, 400);
      }
      const connection = await deps.connection(input);
      if (!connection) return context.json({ error: "AWS connection not found" }, 404);
      if (connection.status !== "connected" || !connection.credentials) {
        return context.json({ error: "Finish connecting this AWS account first" }, 409);
      }
      let rows: AwsLogSubscription[];
      try {
        rows = await deps.setRegions({
          ...input,
          awsAccountId: connection.credentials.accountId,
          filterPattern: awsLogSubscriptionFilterPattern,
          regions: body.data.regions,
        });
      } catch (error) {
        if (error instanceof AwsAccountStreamsElsewhereError) return context.json({ error: error.message }, 409);
        throw error;
      }
      await manager.applyNow(config, rows);
      return context.json(await present({ config, ...input }));
    });
}

export const awsLogSubscriptionRoutes = createAwsLogSubscriptionRoutes();

// What a connection's removal needs to delete its policies afterwards: read
// before the connection and its rows are deleted.
export async function awsLogSubscriptionCleanup(input: {
  integrationAccountId: string;
  organizationId: string;
}, deps: AwsLogSubscriptionDependencies = defaultAwsLogSubscriptionDependencies): Promise<(() => Promise<void>) | null> {
  if (!deps.config()) return null;
  const [connection, rows] = await Promise.all([deps.connection(input), deps.list(input)]);
  if (!connection?.credentials || rows.length === 0) return null;
  const credentials = connection.credentials;
  const regions = rows.map((row) => row.region);
  return () => createAwsLogSubscriptionManager(deps).removeForConnection({ credentials, regions });
}
