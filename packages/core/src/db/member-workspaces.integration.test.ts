import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { member, organization, user } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { listVerifiedMemberWorkspaces } from "./member-workspaces.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_MEMBER_WORKSPACES_DATABASE_URL;
describe.skipIf(!testUrl)("verified member workspaces (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const tag = randomUUID();
  const people = {
    banned: { email: `banned-${tag}@example.com`, id: randomUUID() },
    member: { email: `ash-${tag}@example.com`, id: randomUUID() },
    unverified: { email: `unverified-${tag}@example.com`, id: randomUUID() },
  };

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    const db = getDatabase();
    const createdAt = new Date();
    await db.insert(organization).values({ createdAt, id: organizationId, name: "Acme", slug: organizationId });
    await db.insert(user).values([
      { ...people.member, emailVerified: true, name: "Ash" },
      { ...people.unverified, emailVerified: false, name: "Unverified" },
      { ...people.banned, banned: true, emailVerified: true, name: "Banned" },
    ]);
    await db.insert(member).values(Object.values(people).map((person) => ({
      createdAt,
      organizationId,
      role: "member",
      userId: person.id,
    })));
  });
  afterAll(async () => {
    const db = getDatabase();
    await db.delete(organization).where(inArray(organization.id, [organizationId]));
    await db.delete(user).where(inArray(user.id, Object.values(people).map((person) => person.id)));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("names a verified member's workspaces by email without regard to case", async () => {
    await expect(listVerifiedMemberWorkspaces(` ${people.member.email.toUpperCase()} `))
      .resolves.toEqual([{ name: "Acme" }]);
  });

  it("names none for unverified, banned, and unknown addresses", async () => {
    for (const email of [people.unverified.email, people.banned.email, `nobody-${tag}@example.com`]) {
      await expect(listVerifiedMemberWorkspaces(email)).resolves.toEqual([]);
    }
  });
});
