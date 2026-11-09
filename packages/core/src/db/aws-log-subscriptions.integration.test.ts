import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organization } from "./auth-schema.js";
import {
  AwsAccountStreamsElsewhereError,
  AwsLogSubscriptionConnectionError,
  awsLogSubscriptionAccountsByRegion,
  claimAwsLogSubscriptions,
  claimDueAwsLogSubscriptions,
  deleteAwsLogSubscription,
  findAwsLogSubscriptionWorkspace,
  listAwsLogSubscriptions,
  markAwsLogSubscriptionActive,
  markAwsLogSubscriptionFailed,
  releaseAwsLogSubscriptions,
  removeAllAwsLogSubscriptions,
  setAwsLogSubscriptionRegions,
  withAwsLogDestinationAccounts,
} from "./aws-log-subscriptions.js";
import { closeDatabase, getDatabase } from "./client.js";
import { awsLogSubscriptions, integrationAccounts } from "./schema.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_AWS_LOG_SUBSCRIPTIONS_DATABASE_URL;
describe.skipIf(!testUrl)("AWS log subscriptions (PostgreSQL)", () => {
  const organizations = [randomUUID(), randomUUID()];
  const connections = [randomUUID(), randomUUID()];
  const awsAccountId = String(100000000000 + Math.floor(Math.random() * 899999999999));
  const workspace = { integrationAccountId: connections[0]!, organizationId: organizations[0]! };

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "4");
    const db = getDatabase();
    await db.insert(organization).values(organizations.map((id) => ({ createdAt: new Date(), id, name: "Log test", slug: id })));
    await db.insert(integrationAccounts).values(organizations.map((organizationId, index) => ({
      displayName: `AWS · ${awsAccountId}`,
      externalAccountId: awsAccountId,
      id: connections[index]!,
      organizationId,
      provider: "aws" as const,
    })));
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(inArray(organization.id, organizations));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("adds, removes, and restores regions, and keeps an account to one workspace", async () => {
    const rows = await setAwsLogSubscriptionRegions({ ...workspace, awsAccountId, filterPattern: "?ERROR", regions: ["eu-west-1", "us-east-1", "eu-west-1"] });
    expect(rows.map((row) => [row.region, row.status])).toEqual([["eu-west-1", "pending"], ["us-east-1", "pending"]]);

    await expect(setAwsLogSubscriptionRegions({
      awsAccountId,
      filterPattern: "?ERROR",
      integrationAccountId: connections[1]!,
      organizationId: organizations[1]!,
      regions: ["eu-central-1"],
    })).rejects.toBeInstanceOf(AwsAccountStreamsElsewhereError);

    // A workspace cannot use another workspace's connection.
    await expect(setAwsLogSubscriptionRegions({
      awsAccountId: "999988887777",
      filterPattern: "?ERROR",
      integrationAccountId: connections[1]!,
      organizationId: organizations[0]!,
      regions: ["eu-west-1"],
    })).rejects.toBeInstanceOf(AwsLogSubscriptionConnectionError);

    // The status is constrained in the database.
    await expect(getDatabase().update(awsLogSubscriptions).set({ status: "bogus" as never }).where(eq(awsLogSubscriptions.awsAccountId, awsAccountId)))
      .rejects.toThrow();

    const fewer = await setAwsLogSubscriptionRegions({ ...workspace, awsAccountId, filterPattern: "?ERROR", regions: ["eu-west-1"] });
    expect(fewer.map((row) => [row.region, row.status])).toEqual([["eu-west-1", "pending"], ["us-east-1", "removing"]]);
    const restored = await setAwsLogSubscriptionRegions({ ...workspace, awsAccountId, filterPattern: "?ERROR", regions: ["eu-west-1", "us-east-1"] });
    expect(restored.map((row) => row.status)).toEqual(["pending", "pending"]);
  });

  it("tracks applying, failures, claimed work, and the workspace logs go to", async () => {
    const [eu, us] = await listAwsLogSubscriptions(workspace);
    // Nothing is routed before AWS confirms the policy.
    expect(await findAwsLogSubscriptionWorkspace(awsAccountId, "eu-west-1")).toBeNull();
    await markAwsLogSubscriptionActive(eu!.id, "?ERROR");
    await markAwsLogSubscriptionFailed(us!.id, "boom");
    expect(await findAwsLogSubscriptionWorkspace(awsAccountId, "eu-west-1")).toBe(organizations[0]);
    expect(await findAwsLogSubscriptionWorkspace(awsAccountId, "us-east-1")).toBeNull();
    // A policy that was applied keeps routing when a later update fails.
    await markAwsLogSubscriptionFailed(eu!.id, "throttled");
    expect(await findAwsLogSubscriptionWorkspace(awsAccountId, "eu-west-1")).toBe(organizations[0]);
    await markAwsLogSubscriptionActive(eu!.id, "?ERROR");

    const later = new Date(Date.now() + 60_000);
    const mine = (rows: Array<{ awsAccountId: string; region: string }>) => rows.filter((row) => row.awsAccountId === awsAccountId).map((row) => row.region);
    const due = await claimDueAwsLogSubscriptions({ filterPattern: "?ERROR", leaseMs: 60_000, limit: 100, retryFailedBefore: later });
    expect(mine(due)).toEqual(["us-east-1"]);
    // A claimed row is not handed out again until its lease ends.
    expect(mine(await claimDueAwsLogSubscriptions({ filterPattern: "?ERROR", leaseMs: 60_000, limit: 100, retryFailedBefore: later }))).toEqual([]);
    expect(await claimAwsLogSubscriptions([us!.id], 60_000)).toEqual([]);
    // Releasing its claim, or recording the outcome, lets it go. A release
    // with an older claim's token leaves a newer claim alone.
    await releaseAwsLogSubscriptions(due.find((row) => row.region === "us-east-1")!.claimToken!);
    const reclaimed = await claimAwsLogSubscriptions([us!.id], 60_000);
    expect(mine(reclaimed)).toEqual(["us-east-1"]);
    await releaseAwsLogSubscriptions(due.find((row) => row.region === "us-east-1")!.claimToken!);
    expect(await claimAwsLogSubscriptions([us!.id], 60_000)).toEqual([]);
    await releaseAwsLogSubscriptions(reclaimed[0]!.claimToken!);
    expect(mine(await claimAwsLogSubscriptions([us!.id], 60_000))).toEqual(["us-east-1"]);
    await markAwsLogSubscriptionFailed(us!.id, "boom again");
    expect(mine(await claimAwsLogSubscriptions([us!.id], 60_000))).toEqual(["us-east-1"]);
    await markAwsLogSubscriptionFailed(us!.id, "boom again");
    // A new filter pattern makes active subscriptions due again.
    // Without the ingest token, only removals are handed out.
    expect(mine(await claimDueAwsLogSubscriptions({ filterPattern: "?ERROR ?FATAL", leaseMs: 60_000, limit: 100, removalsOnly: true, retryFailedBefore: new Date(0) }))).toEqual([]);
    const changed = await claimDueAwsLogSubscriptions({ filterPattern: "?ERROR ?FATAL", leaseMs: 60_000, limit: 100, retryFailedBefore: new Date(0) });
    expect(mine(changed)).toEqual(["eu-west-1"]);
    await markAwsLogSubscriptionActive(eu!.id, "?ERROR");

    expect((await awsLogSubscriptionAccountsByRegion()).get("eu-west-1")).toContain(awsAccountId);
    let written: string[] = [];
    expect(await withAwsLogDestinationAccounts("eu-west-1", async (ids) => { written = ids; })).toContain(awsAccountId);
    expect(written).toContain(awsAccountId);
  });

  it("removes every region of a connection and deletes only rows marked for removal", async () => {
    const [eu] = await listAwsLogSubscriptions(workspace);
    await deleteAwsLogSubscription(eu!.id);
    expect(await listAwsLogSubscriptions(workspace)).toHaveLength(2);
    const removed = await removeAllAwsLogSubscriptions(workspace);
    expect(removed.map((row) => row.status)).toEqual(["removing", "removing"]);
    expect(await findAwsLogSubscriptionWorkspace(awsAccountId, "eu-west-1")).toBeNull();
    for (const row of removed) await deleteAwsLogSubscription(row.id);
    expect(await listAwsLogSubscriptions(workspace)).toEqual([]);
    // The connection's removal cascades to anything left.
    await getDatabase().delete(integrationAccounts).where(eq(integrationAccounts.id, connections[0]!));
  });
});
