import { Hono } from "hono";
import { z } from "zod";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  AwsAccountStreamsElsewhereError,
  AwsLogSubscriptionConnectionError,
  claimAwsLogSubscriptions,
  claimDueAwsLogSubscriptions,
  deleteAwsLogSubscription as deleteAwsLogSubscriptionRow,
  listAwsLogSubscriptions,
  markAwsLogSubscriptionActive,
  markAwsLogSubscriptionFailed,
  markAwsLogSubscriptionRemovalFailed,
  releaseAwsLogSubscriptions,
  removeAllAwsLogSubscriptions,
  setAwsLogSubscriptionRegions,
  withAwsLogDestinationAccounts,
  type AwsLogSubscription,
} from "../../../../packages/core/src/db/aws-log-subscriptions.js";
import { getOrganizationIntegrationAccount } from "../../../../packages/core/src/db/integrations.js";
import {
  assumeAwsInvestigationRole,
  awsConnectionCredentialsSchema,
  createAwsCloudFormationTemplateUrl,
  parseSnsTopicArn,
  type AwsConnectionCredentials,
} from "../../../../packages/core/src/integrations/aws.js";
import { awsRegions } from "../../../../packages/core/src/integrations/aws-regions.js";
import { awsStackUpdateConsoleUrl, findAwsStack, type AwsStackLocation } from "../../../../packages/core/src/integrations/aws-stack.js";
import {
  assumeAwsLogSubscriptionRole,
  awsLogSubscriptionRoleName,
  AwsLogSubscriptionRoleUnavailableError,
  awsLogDestinationArn,
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
  claim: typeof claimAwsLogSubscriptions;
  claimDue: typeof claimDueAwsLogSubscriptions;
  config: () => AwsLogSubscriptionConfig | null;
  connection: (input: { integrationAccountId: string; organizationId: string }) => Promise<{
    credentials: AwsConnectionCredentials | null;
    status: string;
  } | null>;
  deleteRow: typeof deleteAwsLogSubscriptionRow;
  deleteSubscription: typeof deleteAwsLogSubscription;
  destinationAccounts: typeof withAwsLogDestinationAccounts;
  list: typeof listAwsLogSubscriptions;
  markActive: typeof markAwsLogSubscriptionActive;
  markFailed: typeof markAwsLogSubscriptionFailed;
  markRemovalFailed: typeof markAwsLogSubscriptionRemovalFailed;
  now: () => number;
  putDestinationPolicy: typeof putAwsLogDestinationPolicy;
  putSubscription: typeof putAwsLogSubscription;
  release: typeof releaseAwsLogSubscriptions;
  removeAll: typeof removeAllAwsLogSubscriptions;
  setRegions: typeof setAwsLogSubscriptionRegions;
  // Finds the connection's ResponderInvestigationAccess stack with its
  // read-only role, looking in `preferredRegion` first.
  locateStack: (connection: AwsConnectionCredentials, preferredRegion: string | null) => Promise<AwsStackLocation | null>;
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
  claim: claimAwsLogSubscriptions,
  claimDue: claimDueAwsLogSubscriptions,
  config: () => awsLogSubscriptionConfig(),
  connection: loadConnection,
  deleteRow: deleteAwsLogSubscriptionRow,
  deleteSubscription: deleteAwsLogSubscription,
  destinationAccounts: withAwsLogDestinationAccounts,
  list: listAwsLogSubscriptions,
  markActive: markAwsLogSubscriptionActive,
  markFailed: markAwsLogSubscriptionFailed,
  markRemovalFailed: markAwsLogSubscriptionRemovalFailed,
  now: Date.now,
  putDestinationPolicy: putAwsLogDestinationPolicy,
  putSubscription: putAwsLogSubscription,
  release: releaseAwsLogSubscriptions,
  removeAll: removeAllAwsLogSubscriptions,
  setRegions: setAwsLogSubscriptionRegions,
  locateStack: async (connection, preferredRegion) => findAwsStack({
    credentials: await assumeAwsInvestigationRole(connection, { sessionName: "superlog-stack-lookup" }),
    regions: [...new Set([...(preferredRegion ? [preferredRegion] : []), ...awsRegions])],
    stackName: AWS_STACK_NAME,
  }),
  templateUrl: () => createAwsCloudFormationTemplateUrl(),
  topicArn: () => awsRegistrationTopicArn(),
};

const retryFailedAfterMs = 10 * 60_000;
// A region waiting for the stack update is retried sooner, so it starts
// streaming soon after the update.
const retryWaitingAfterMs = 60_000;
// How long one process holds rows it works on.
const leaseMs = 5 * 60_000;
// Destination policies are rewritten when their account list changes, and
// at least this often, so a policy changed by hand is put back.
const destinationRefreshMs = 15 * 60_000;

function log(fields: Record<string, unknown>): void {
  const write = fields.outcome === "failed" ? console.warn : console.info;
  write(JSON.stringify({ event: "aws_log_subscription", ...fields }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAwsLogSubscriptionManager(deps: AwsLogSubscriptionDependencies = defaultAwsLogSubscriptionDependencies) {
  const applied = new Map<string, { at: number; policy: string }>();

  // Makes each region's destination accept exactly the AWS accounts that
  // subscribe there. The list is read under a per-region lock, so processes
  // cannot overwrite each other with lists read at different times. A region
  // whose list this process already put is skipped until the refresh
  // interval passes.
  async function syncDestinations(config: AwsLogSubscriptionConfig, regions: string[] = config.regions): Promise<void> {
    for (const region of regions) {
      if (!config.regions.includes(region)) continue;
      try {
        await deps.destinationAccounts(region, async (accountIds) => {
          const key = accountIds.join(",");
          const previous = applied.get(region);
          if (previous && previous.policy === key && deps.now() - previous.at < destinationRefreshMs) return;
          await deps.putDestinationPolicy({ accountIds, config, region });
          applied.set(region, { at: deps.now(), policy: key });
        });
      } catch (error) {
        applied.delete(region);
        log({ error: errorText(error), outcome: "failed", region, stage: "destination_policy" });
      }
    }
  }

  // Applies or removes claimed subscriptions, one AWS account at a time.
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
        const describe = (error: unknown) => describeAwsLogSubscriptionError(error, row.region, awsLogDestinationArn(config, row.region));
        if (row.status === "removing") {
          if (!credentials) {
            const described = describe(assumeError);
            if (assumeError instanceof AwsLogSubscriptionRoleUnavailableError) {
              // The role is gone, so the policy cannot be deleted from here.
              // The destination stops accepting the account once the row is
              // gone.
              await deps.deleteRow(row.id);
              log({ ...base, outcome: "forgotten", stage: "remove" });
            } else {
              await deps.markRemovalFailed(row.id, described.message);
              log({ ...base, outcome: "failed", problem: described.problem, stage: "remove" });
            }
            continue;
          }
          try {
            await deps.deleteSubscription({ credentials, region: row.region });
            await deps.deleteRow(row.id);
            log({ ...base, outcome: "removed", stage: "remove" });
          } catch (error) {
            const described = describe(error);
            await deps.markRemovalFailed(row.id, described.message);
            log({ ...base, outcome: "failed", problem: described.problem, stage: "remove" });
          }
          continue;
        }
        if (!credentials) {
          const described = describe(assumeError);
          await deps.markFailed(row.id, described.message);
          log({ ...base, outcome: "failed", problem: described.problem, stage: "assume" });
          continue;
        }
        try {
          await deps.putSubscription({ config, credentials, filterPattern: awsLogSubscriptionFilterPattern, region: row.region });
          await deps.markActive(row.id, awsLogSubscriptionFilterPattern);
          log({ ...base, outcome: "applied", stage: "apply" });
        } catch (error) {
          const described = describe(error);
          await deps.markFailed(row.id, described.message);
          log({ ...base, outcome: "failed", problem: described.problem, stage: "apply" });
        }
      }
    }
  }

  // One pass: the destinations first, since CloudWatch Logs checks a
  // destination's policy when a subscription is created, then the due work
  // this process claims. Without the ingest token only removals run.
  async function reconcile(): Promise<void> {
    const config = deps.config();
    if (!config) return;
    await syncDestinations(config);
    const rows = await deps.claimDue({
      filterPattern: awsLogSubscriptionFilterPattern,
      leaseMs,
      limit: 100,
      removalsOnly: !config.acceptsLogs,
      retryFailedBefore: new Date(deps.now() - retryFailedAfterMs),
      retryWaitingBefore: new Date(deps.now() - retryWaitingAfterMs),
    });
    await process(config, rows);
  }

  // Applies a connection's changes now, so the admin sees the outcome. Rows
  // another process holds are left to it.
  async function applyNow(config: AwsLogSubscriptionConfig, rows: AwsLogSubscription[]): Promise<void> {
    const work = rows.filter((row) => row.status !== "active" || row.filterPattern !== awsLogSubscriptionFilterPattern);
    if (work.length === 0) return;
    await syncDestinations(config, [...new Set(work.map((row) => row.region))]);
    await process(config, await deps.claim(work.map((row) => row.id), leaseMs));
  }

  // Deletes a connection's policies before the connection is removed. The
  // removal goes ahead only when every policy is gone, or the role that
  // could delete them is gone too. Otherwise the rows stay marked for
  // removal, the scheduler keeps retrying, and the caller is told why.
  async function removeBeforeDisconnect(input: {
    integrationAccountId: string;
    organizationId: string;
  }): Promise<{ ok: true; left: string[]; removed: string[] } | { error: string; ok: false }> {
    const config = deps.config();
    if (!config) return { left: [], ok: true, removed: [] };
    const rows = await deps.removeAll(input);
    if (rows.length === 0) return { left: [], ok: true, removed: [] };
    const claimed = await deps.claim(rows.map((row) => row.id), leaseMs);
    if (claimed.length < rows.length) {
      // Another process holds some rows; let go of the ones claimed here so
      // a retry is not blocked by this attempt too.
      const token = claimed[0]?.claimToken;
      if (token) await deps.release(token);
      return { error: "Superlog is still updating this account's log subscriptions. Try again in a minute.", ok: false };
    }
    const connection = await deps.connection(input);
    let credentials: AwsTemporaryCredentials | null = null;
    try {
      if (!connection?.credentials) throw new AwsLogSubscriptionRoleUnavailableError(new Error("The AWS connection has no credentials"));
      credentials = await deps.assume(connection.credentials, config);
    } catch (error) {
      if (!(error instanceof AwsLogSubscriptionRoleUnavailableError)) {
        const described = describeAwsLogSubscriptionError(error, rows[0]!.region);
        for (const row of rows) await deps.markRemovalFailed(row.id, described.message);
        return { error: `Superlog could not remove this account's log subscriptions: ${described.message}`, ok: false };
      }
      // Without the role nothing can be deleted from here. The policies stay
      // in the customer's account, pointing at a destination that will no
      // longer accept them.
      for (const row of rows) await deps.deleteRow(row.id);
      await syncDestinations(config, rows.map((row) => row.region));
      log({ awsAccountId: rows[0]!.awsAccountId, outcome: "forgotten", stage: "disconnect" });
      return { left: rows.map((row) => row.region), ok: true, removed: [] };
    }
    const failed: string[] = [];
    for (const row of rows) {
      try {
        await deps.deleteSubscription({ credentials, region: row.region });
        await deps.deleteRow(row.id);
      } catch (error) {
        const described = describeAwsLogSubscriptionError(error, row.region, awsLogDestinationArn(config, row.region));
        await deps.markRemovalFailed(row.id, described.message);
        failed.push(`${row.region}: ${described.message}`);
      }
    }
    await syncDestinations(config, rows.map((row) => row.region));
    if (failed.length > 0) {
      return { error: `Superlog could not remove the log subscriptions in ${failed.join("; ")} Try again, or remove those regions first.`, ok: false };
    }
    return { left: [], ok: true, removed: rows.map((row) => row.region) };
  }

  // Puts a connection's subscriptions back when its removal was blocked
  // after they were deleted, as when an automation started using it in
  // between.
  async function restore(input: { integrationAccountId: string; organizationId: string; regions: string[] }): Promise<void> {
    const config = deps.config();
    if (!config?.acceptsLogs || input.regions.length === 0) return;
    const connection = await deps.connection(input);
    if (!connection?.credentials) return;
    const rows = await deps.setRegions({
      awsAccountId: connection.credentials.accountId,
      filterPattern: awsLogSubscriptionFilterPattern,
      integrationAccountId: input.integrationAccountId,
      organizationId: input.organizationId,
      regions: input.regions,
    });
    await applyNow(config, rows);
  }

  return { applyNow, reconcile, removeBeforeDisconnect, restore, syncDestinations };
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
      console.error(JSON.stringify({ error: errorText(error), event: "aws_log_subscription_pass_failed" }));
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

// What removing an AWS connection does first: delete its policies.
export async function removeAwsLogSubscriptionsBeforeDisconnect(input: {
  integrationAccountId: string;
  organizationId: string;
}, deps: AwsLogSubscriptionDependencies = defaultAwsLogSubscriptionDependencies) {
  return createAwsLogSubscriptionManager(deps).removeBeforeDisconnect(input);
}

// Puts subscriptions back after a removal that was blocked at the last step.
// Best effort: the scheduler retries whatever does not apply now.
export async function restoreAwsLogSubscriptions(input: {
  integrationAccountId: string;
  organizationId: string;
  regions: string[];
}, deps: AwsLogSubscriptionDependencies = defaultAwsLogSubscriptionDependencies): Promise<void> {
  try {
    await createAwsLogSubscriptionManager(deps).restore(input);
  } catch (error) {
    log({ error: errorText(error), organizationId: input.organizationId, outcome: "failed", stage: "restore" });
  }
}

// --- Routes ---------------------------------------------------------------

const regionsSchema = z.object({ regions: z.array(z.string()).max(40) });

function isWorkspaceAdmin(role: string): boolean {
  return role.split(",").some((value) => ["owner", "admin"].includes(value.trim()));
}

export const AWS_STACK_NAME = "ResponderInvestigationAccess";

// How an admin adds ResponderLogSubscriptionRole to a stack created before
// it existed: one update that keeps every parameter the stack already has.
// Stacks made before one-click setup have no RegistrationTopicArn. When the
// stack was not found, the command keeps it too: an older stack then rejects
// the command, where leaving it out would quietly reset it on newer ones.
export function awsStackUpdateCommand(input: {
  logSubscriptionPrincipalArn: string;
  parameterKeys?: string[] | null;
  region: string | null;
  templateUrl: string | null;
}): string {
  const kept = (input.parameterKeys ?? ["ResponderPrincipalArn", "ExternalId", "RegistrationTopicArn"])
    .filter((key) => key !== "LogSubscriptionPrincipalArn");
  return [
    "aws cloudformation update-stack",
    ...(input.region ? [`--region ${input.region}`] : []),
    `--stack-name ${AWS_STACK_NAME}`,
    input.templateUrl ? `--template-url '${input.templateUrl}'` : "--template-body file://responder-aws-access.yaml",
    "--capabilities CAPABILITY_NAMED_IAM",
    "--parameters",
    ...kept.map((key) => `ParameterKey=${key},UsePreviousValue=true`),
    `ParameterKey=LogSubscriptionPrincipalArn,ParameterValue=${input.logSubscriptionPrincipalArn}`,
  ].join(" ");
}

// A region that failed only because the stack predates the subscription role
// is waiting for the customer, not broken.
export function isWaitingForStackUpdate(row: Pick<AwsLogSubscription, "lastError" | "status">): boolean {
  return row.status === "failed" && (row.lastError?.includes(awsLogSubscriptionRoleName) ?? false);
}

export function createAwsLogSubscriptionRoutes(deps: AwsLogSubscriptionDependencies = defaultAwsLogSubscriptionDependencies) {
  const manager = createAwsLogSubscriptionManager(deps);
  // Where each connection's stack is, found once and kept for a while.
  const stacks = new Map<string, { at: number; location: AwsStackLocation | null }>();
  // When each connection's waiting regions were last tried from a page load.
  const checked = new Map<string, number>();
  const stackCacheMs = 30 * 60_000;
  const missingStackCacheMs = 5 * 60_000;
  const recheckMs = 20_000;

  async function stackOf(integrationAccountId: string, organizationId: string, preferredRegion: string | null) {
    const cached = stacks.get(integrationAccountId);
    if (cached && deps.now() - cached.at < (cached.location ? stackCacheMs : missingStackCacheMs)) return cached.location;
    const connection = await deps.connection({ integrationAccountId, organizationId });
    const location = connection?.credentials
      ? await deps.locateStack(connection.credentials, preferredRegion).catch(() => null)
      : null;
    stacks.set(integrationAccountId, { at: deps.now(), location });
    return location;
  }

  // While the page is open, regions waiting for the stack update are tried
  // again every few seconds, so they start soon after the update.
  async function recheckWaiting(config: AwsLogSubscriptionConfig, input: { integrationAccountId: string; organizationId: string }) {
    const last = checked.get(input.integrationAccountId);
    if (last !== undefined && deps.now() - last < recheckMs) return;
    const waiting = (await deps.list(input)).filter(isWaitingForStackUpdate);
    if (waiting.length === 0) return;
    checked.set(input.integrationAccountId, deps.now());
    await manager.applyNow(config, waiting);
  }

  async function present(input: {
    canManage: boolean;
    config: AwsLogSubscriptionConfig;
    integrationAccountId: string;
    organizationId: string;
  }) {
    const subscriptions = await deps.list(input);
    const roleMissing = subscriptions.some(isWaitingForStackUpdate);
    const topicArn = deps.topicArn();
    const topicRegion = topicArn ? parseSnsTopicArn(topicArn)?.region ?? null : null;
    const templateUrl = roleMissing ? await deps.templateUrl().catch(() => null) : null;
    const stack = roleMissing ? await stackOf(input.integrationAccountId, input.organizationId, topicRegion) : null;
    const stackRegion = stack?.region ?? topicRegion;
    return {
      available: true,
      canManage: input.canManage,
      filter: "Error lines only: ERROR, FATAL, and CRITICAL lines, exceptions, tracebacks, and panics.",
      regions: input.config.regions,
      stackUpdate: roleMissing
        ? {
            command: awsStackUpdateCommand({
              logSubscriptionPrincipalArn: input.config.principalArn,
              parameterKeys: stack?.parameterKeys ?? null,
              region: stackRegion,
              templateUrl,
            }),
            consoleUrl: stackRegion
              ? awsStackUpdateConsoleUrl({ region: stackRegion, stackId: stack?.stackId ?? null, templateUrl })
              : null,
            logSubscriptionPrincipalArn: input.config.principalArn,
            region: stackRegion,
            stackName: AWS_STACK_NAME,
            templateUrl,
          }
        : null,
      subscriptions: subscriptions.map((row) => ({
        appliedAt: row.appliedAt?.toISOString() ?? null,
        lastError: isWaitingForStackUpdate(row) ? null : row.lastError,
        region: row.region,
        status: isWaitingForStackUpdate(row) ? "waiting" as const : row.status,
      })),
    };
  }

  return new Hono()
    .get("/:integrationAccountId", async (context) => {
      const tenant = await getActiveTenant(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      const config = deps.config();
      if (!config?.acceptsLogs) return context.json({ available: false, canManage: false, regions: [], stackUpdate: null, subscriptions: [] });
      const input = { integrationAccountId: context.req.param("integrationAccountId"), organizationId: tenant.organizationId };
      if (!z.uuid().safeParse(input.integrationAccountId).success || !(await deps.connection(input))) {
        return context.json({ error: "AWS connection not found" }, 404);
      }
      await recheckWaiting(config, input).catch((error: unknown) => {
        log({ error: errorText(error), organizationId: input.organizationId, outcome: "failed", stage: "recheck" });
      });
      return context.json(await present({ ...input, canManage: isWorkspaceAdmin(tenant.role), config }));
    })
    .put("/:integrationAccountId", async (context) => {
      const tenant = await getActiveTenant(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      if (!isWorkspaceAdmin(tenant.role)) {
        return context.json({ error: "Only workspace owners and admins can change log streaming" }, 403);
      }
      const config = deps.config();
      if (!config?.acceptsLogs) return context.json({ error: "Log streaming is not available here" }, 404);
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
        if (error instanceof AwsLogSubscriptionConnectionError) return context.json({ error: error.message }, 404);
        throw error;
      }
      await manager.applyNow(config, rows);
      return context.json(await present({ ...input, canManage: true, config }));
    });
}

export const awsLogSubscriptionRoutes = createAwsLogSubscriptionRoutes();
