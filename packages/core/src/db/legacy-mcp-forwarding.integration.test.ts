import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { member, organization, user } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { findLegacyMcpForwardMember } from "./legacy-mcp-forwarding.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_LEGACY_MCP_FORWARD_DATABASE_URL;
describe.skipIf(!testUrl)("legacy MCP forward members (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const tag = randomUUID();
  const people = {
    banned: { email: `banned-${tag}@example.com`, id: randomUUID() },
    member: { email: `ash-${tag}@example.com`, id: randomUUID() },
    outsider: { email: `outsider-${tag}@example.com`, id: randomUUID() },
    unverified: { email: `unverified-${tag}@example.com`, id: randomUUID() },
  };

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    const db = getDatabase();
    const createdAt = new Date();
    await db.insert(organization).values([
      { createdAt, id: organizationId, name: "Forward test", slug: organizationId },
      { createdAt, id: otherOrganizationId, name: "Other", slug: otherOrganizationId },
    ]);
    await db.insert(user).values([
      { ...people.member, emailVerified: true, name: "Ash" },
      { ...people.outsider, emailVerified: true, name: "Outsider" },
      { ...people.unverified, emailVerified: false, name: "Unverified" },
      { ...people.banned, banned: true, emailVerified: true, name: "Banned" },
    ]);
    await db.insert(member).values([
      { createdAt, organizationId, role: "admin", userId: people.member.id },
      { createdAt, organizationId: otherOrganizationId, role: "owner", userId: people.outsider.id },
      { createdAt, organizationId, role: "member", userId: people.unverified.id },
      { createdAt, organizationId, role: "member", userId: people.banned.id },
    ]);
  });
  afterAll(async () => {
    const db = getDatabase();
    await db.delete(organization).where(inArray(organization.id, [organizationId, otherOrganizationId]));
    await db.delete(user).where(inArray(user.id, Object.values(people).map((person) => person.id)));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("finds the member by email without regard to case", async () => {
    await expect(findLegacyMcpForwardMember(organizationId, ` ${people.member.email.toUpperCase()} `))
      .resolves.toEqual({
        organizationId,
        role: "admin",
        user: { email: people.member.email, id: people.member.id, name: "Ash" },
      });
  });

  it("refuses other workspaces' members, unverified and banned people, and missing workspaces", async () => {
    for (const email of [people.outsider.email, people.unverified.email, people.banned.email]) {
      await expect(findLegacyMcpForwardMember(organizationId, email)).resolves.toBeNull();
    }
    await expect(findLegacyMcpForwardMember(randomUUID(), people.member.email)).resolves.toBeNull();
  });
});
