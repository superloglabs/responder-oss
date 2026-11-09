import { and, asc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { awsLogSubscriptions } from "./schema.js";

export type AwsLogSubscriptionStatus = "active" | "failed" | "pending" | "removing";

export interface AwsLogSubscription {
  appliedAt: Date | null;
  awsAccountId: string;
  filterPattern: string;
  id: string;
  integrationAccountId: string;
  lastError: string | null;
  organizationId: string;
  region: string;
  status: AwsLogSubscriptionStatus;
  updatedAt: Date;
}

const columns = {
  appliedAt: awsLogSubscriptions.appliedAt,
  awsAccountId: awsLogSubscriptions.awsAccountId,
  filterPattern: awsLogSubscriptions.filterPattern,
  id: awsLogSubscriptions.id,
  integrationAccountId: awsLogSubscriptions.integrationAccountId,
  lastError: awsLogSubscriptions.lastError,
  organizationId: awsLogSubscriptions.organizationId,
  region: awsLogSubscriptions.region,
  status: awsLogSubscriptions.status,
  updatedAt: awsLogSubscriptions.updatedAt,
};

// Another workspace already streams this AWS account's logs.
export class AwsAccountStreamsElsewhereError extends Error {
  constructor() {
    super("This AWS account already streams its logs to another Superlog workspace");
  }
}

export async function listAwsLogSubscriptions(input: {
  integrationAccountId: string;
  organizationId: string;
}): Promise<AwsLogSubscription[]> {
  return getDatabase()
    .select(columns)
    .from(awsLogSubscriptions)
    .where(and(
      eq(awsLogSubscriptions.organizationId, input.organizationId),
      eq(awsLogSubscriptions.integrationAccountId, input.integrationAccountId),
    ))
    .orderBy(asc(awsLogSubscriptions.region));
}

// Makes the chosen regions the connection's subscriptions. New regions start
// pending; regions no longer chosen are marked for removal; a removal that
// is chosen again is applied again. The account's rows are locked so two
// workspaces cannot claim one AWS account at once.
export async function setAwsLogSubscriptionRegions(input: {
  awsAccountId: string;
  filterPattern: string;
  integrationAccountId: string;
  organizationId: string;
  regions: string[];
}): Promise<AwsLogSubscription[]> {
  const regions = [...new Set(input.regions)];
  return getDatabase().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`aws_log_subscriptions:${input.awsAccountId}`}))`);
    const existing = await tx
      .select(columns)
      .from(awsLogSubscriptions)
      .where(eq(awsLogSubscriptions.awsAccountId, input.awsAccountId));
    if (existing.some((row) => row.organizationId !== input.organizationId || row.integrationAccountId !== input.integrationAccountId)) {
      throw new AwsAccountStreamsElsewhereError();
    }
    const now = new Date();
    const known = new Set(existing.map((row) => row.region));
    const added = regions.filter((region) => !known.has(region));
    if (added.length > 0) {
      await tx.insert(awsLogSubscriptions).values(added.map((region) => ({
        awsAccountId: input.awsAccountId,
        filterPattern: input.filterPattern,
        integrationAccountId: input.integrationAccountId,
        organizationId: input.organizationId,
        region,
        status: "pending" as const,
      })));
    }
    const removed = existing.filter((row) => !regions.includes(row.region) && row.status !== "removing");
    if (removed.length > 0) {
      await tx.update(awsLogSubscriptions)
        .set({ lastError: null, status: "removing", updatedAt: now })
        .where(inArray(awsLogSubscriptions.id, removed.map((row) => row.id)));
    }
    const restored = existing.filter((row) => regions.includes(row.region) && row.status === "removing");
    if (restored.length > 0) {
      await tx.update(awsLogSubscriptions)
        .set({ lastError: null, status: "pending", updatedAt: now })
        .where(inArray(awsLogSubscriptions.id, restored.map((row) => row.id)));
    }
    return tx
      .select(columns)
      .from(awsLogSubscriptions)
      .where(eq(awsLogSubscriptions.integrationAccountId, input.integrationAccountId))
      .orderBy(asc(awsLogSubscriptions.region));
  });
}

// Marks every subscription of a connection for removal, as when the
// connection is removed.
export async function removeAllAwsLogSubscriptions(input: {
  integrationAccountId: string;
  organizationId: string;
}): Promise<AwsLogSubscription[]> {
  return getDatabase()
    .update(awsLogSubscriptions)
    .set({ lastError: null, status: "removing", updatedAt: new Date() })
    .where(and(
      eq(awsLogSubscriptions.organizationId, input.organizationId),
      eq(awsLogSubscriptions.integrationAccountId, input.integrationAccountId),
    ))
    .returning(columns);
}

// Subscriptions that need work: pending, being removed, failed a while ago,
// or applied with a filter pattern other than the current one.
export async function findDueAwsLogSubscriptions(input: {
  filterPattern: string;
  limit: number;
  retryFailedBefore: Date;
}): Promise<AwsLogSubscription[]> {
  return getDatabase()
    .select(columns)
    .from(awsLogSubscriptions)
    .where(or(
      eq(awsLogSubscriptions.status, "pending"),
      eq(awsLogSubscriptions.status, "removing"),
      and(eq(awsLogSubscriptions.status, "failed"), lt(awsLogSubscriptions.updatedAt, input.retryFailedBefore)),
      and(eq(awsLogSubscriptions.status, "active"), ne(awsLogSubscriptions.filterPattern, input.filterPattern)),
    ))
    .orderBy(asc(awsLogSubscriptions.updatedAt))
    .limit(input.limit);
}

export async function markAwsLogSubscriptionActive(id: string, filterPattern: string): Promise<void> {
  const now = new Date();
  await getDatabase()
    .update(awsLogSubscriptions)
    .set({ appliedAt: now, filterPattern, lastError: null, status: "active", updatedAt: now })
    .where(and(eq(awsLogSubscriptions.id, id), ne(awsLogSubscriptions.status, "removing")));
}

export async function markAwsLogSubscriptionFailed(id: string, error: string): Promise<void> {
  await getDatabase()
    .update(awsLogSubscriptions)
    .set({ lastError: error.slice(0, 1000), status: "failed", updatedAt: new Date() })
    .where(and(eq(awsLogSubscriptions.id, id), ne(awsLogSubscriptions.status, "removing")));
}

// A removal that failed stays marked for removal, with its error.
export async function markAwsLogSubscriptionRemovalFailed(id: string, error: string): Promise<void> {
  await getDatabase()
    .update(awsLogSubscriptions)
    .set({ lastError: error.slice(0, 1000), updatedAt: new Date() })
    .where(and(eq(awsLogSubscriptions.id, id), eq(awsLogSubscriptions.status, "removing")));
}

export async function deleteAwsLogSubscription(id: string): Promise<void> {
  await getDatabase()
    .delete(awsLogSubscriptions)
    .where(and(eq(awsLogSubscriptions.id, id), eq(awsLogSubscriptions.status, "removing")));
}

// The AWS accounts each region's destination must accept: every account with
// a subscription there, including ones still being applied or removed, since
// CloudWatch Logs checks the destination's policy when the subscription is
// created.
export async function awsLogSubscriptionAccountsByRegion(): Promise<Map<string, string[]>> {
  const rows = await getDatabase()
    .selectDistinct({ awsAccountId: awsLogSubscriptions.awsAccountId, region: awsLogSubscriptions.region })
    .from(awsLogSubscriptions)
    .orderBy(asc(awsLogSubscriptions.region), asc(awsLogSubscriptions.awsAccountId));
  const byRegion = new Map<string, string[]>();
  for (const row of rows) byRegion.set(row.region, [...(byRegion.get(row.region) ?? []), row.awsAccountId]);
  return byRegion;
}

// The workspace that receives an AWS account's logs from a region.
export async function findAwsLogSubscriptionWorkspace(awsAccountId: string, region: string): Promise<string | null> {
  const [row] = await getDatabase()
    .select({ organizationId: awsLogSubscriptions.organizationId })
    .from(awsLogSubscriptions)
    .where(and(
      eq(awsLogSubscriptions.awsAccountId, awsAccountId),
      eq(awsLogSubscriptions.region, region),
      ne(awsLogSubscriptions.status, "removing"),
    ))
    .limit(1);
  return row?.organizationId ?? null;
}
