import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { member, organization, user } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { canConnectSlackTeam } from "./integrations.js";
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
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
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
      status: "error",
    });
  });
  afterAll(async () => {
    const db = getDatabase();
    await db.delete(organization).where(inArray(organization.id, [holder, other]));
    await db.delete(user).where(inArray(user.id, Object.values(people)));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("lets anyone connect a Slack team no workspace holds", async () => {
    await expect(canConnectSlackTeam({ organizationId: other, teamId: `T${randomUUID()}`, userId: people.stranger }))
      .resolves.toBe(true);
  });

  it("lets the workspace that holds a Slack team connect it again", async () => {
    await expect(canConnectSlackTeam({ organizationId: holder, teamId, userId: people.member }))
      .resolves.toBe(true);
  });

  it("lets an owner or admin of a holding workspace connect it to another", async () => {
    for (const userId of [people.owner, people.admin]) {
      await expect(canConnectSlackTeam({ organizationId: other, teamId, userId })).resolves.toBe(true);
    }
  });

  it("refuses everyone else, even while the held connection has failed", async () => {
    for (const userId of [people.member, people.stranger]) {
      await expect(canConnectSlackTeam({ organizationId: other, teamId, userId })).resolves.toBe(false);
    }
  });
});
