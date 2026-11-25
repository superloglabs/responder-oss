import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { member, organization, user } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { connectSlackTeamAccount } from "./integrations.js";
import { integrationAccounts } from "./schema.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_SLACK_TEAM_CONNECTIONS_DATABASE_URL;
describe.skipIf(!testUrl)("Slack team connections (PostgreSQL)", () => {
  const tag = randomUUID();
  const holder = randomUUID();
  const other = randomUUID();
  const teamId = `T${tag}`;
  const people = {
    admin: randomUUID(),
    member: randomUUID(),
    owner: randomUUID(),
    stranger: randomUUID(),
  };

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "10");
    const db = getDatabase();
    const createdAt = new Date();
    await db.insert(organization).values([
      { createdAt, id: holder, name: "Holder", slug: holder },
      { createdAt, id: other, name: "Other", slug: other },
    ]);
    await db.insert(user).values(Object.entries(people).map(([name, id]) => ({
      email: `${name}-${tag}@example.com`, emailVerified: true, id, name,
    })));
    await db.insert(member).values([
      { createdAt, organizationId: holder, role: "admin", userId: people.admin },
      { createdAt, organizationId: holder, role: "member", userId: people.member },
      { createdAt, organizationId: holder, role: "owner", userId: people.owner },
      ...Object.values(people).map((userId) => ({ createdAt, organizationId: other, role: "member", userId })),
    ]);
    await db.insert(integrationAccounts).values({
      displayName: "Acme",
      externalAccountId: teamId,
      organizationId: holder,
      provider: "slack",
      status: "connected",
    });
  });
  afterAll(async () => {
    const db = getDatabase();
    await db.delete(organization).where(inArray(organization.id, [holder, other]));
    await db.delete(user).where(inArray(user.id, Object.values(people)));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  const connect = (organizationId: string, team: string, userId: string) =>
    connectSlackTeamAccount({ displayName: "Acme", externalAccountId: team, organizationId, userId });
  const holdersOf = async (team: string) =>
    (await getDatabase()
      .select({ organizationId: integrationAccounts.organizationId })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.provider, "slack"), eq(integrationAccounts.externalAccountId, team))))
      .map((row) => row.organizationId)
      .sort();

  it("lets anyone connect a Slack team no workspace holds", async () => {
    const team = `T${randomUUID()}`;
    await expect(connect(other, team, people.stranger)).resolves.toEqual(expect.any(String));
    await expect(holdersOf(team)).resolves.toEqual([other]);
  });

  it("lets the workspace that holds a Slack team connect it again", async () => {
    await expect(connect(holder, teamId, people.member)).resolves.toEqual(expect.any(String));
    await expect(holdersOf(teamId)).resolves.toEqual([holder]);
  });

  it("refuses everyone else, even while the held connection has failed", async () => {
    await getDatabase().update(integrationAccounts).set({ status: "error" })
      .where(eq(integrationAccounts.externalAccountId, teamId));
    for (const userId of [people.member, people.stranger]) {
      await expect(connect(other, teamId, userId)).resolves.toBeNull();
    }
    await expect(holdersOf(teamId)).resolves.toEqual([holder]);
  });

  it("lets an owner or admin of a holding workspace connect it to another", async () => {
    await expect(connect(other, teamId, people.admin)).resolves.toEqual(expect.any(String));
    await expect(holdersOf(teamId)).resolves.toEqual([holder, other].sort());
  });

  it("lets only one of two simultaneous first connections through", async () => {
    const teams = Array.from({ length: 20 }, () => `T${randomUUID()}`);
    const results = await Promise.all(teams.flatMap((team) => [
      connect(holder, team, people.stranger),
      connect(other, team, people.stranger),
    ]));
    expect(results.filter((result) => result !== null)).toHaveLength(teams.length);
    for (const team of teams) await expect(holdersOf(team)).resolves.toHaveLength(1);
  });
});
