import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { member, organization, user } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { claimLegacyMcpForwardAssertion, findForwardedWorkspaceMember } from "./legacy-mcp-forwarding.js";
import { legacyMcpForwards } from "./schema.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_LEGACY_MCP_FORWARD_DATABASE_URL;
describe.skipIf(!testUrl)("legacy MCP forward members (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const legacyProjectId = randomUUID();
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
    await db.insert(legacyMcpForwards).values({ legacyProjectId, organizationId });
  });
  afterAll(async () => {
    const db = getDatabase();
    await db.delete(organization).where(inArray(organization.id, [organizationId, otherOrganizationId]));
    await db.delete(user).where(inArray(user.id, Object.values(people).map((person) => person.id)));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("finds the member of the workspace a listed project moved to", async () => {
    await expect(findForwardedWorkspaceMember(legacyProjectId, people.member.email.toUpperCase()))
      .resolves.toEqual({
        organizationId,
        role: "admin",
        user: { email: people.member.email, id: people.member.id, name: "Ash" },
      });
  });

  it("refuses unlisted projects, other workspaces' members, and unverified or banned people", async () => {
    await expect(findForwardedWorkspaceMember(organizationId, people.member.email)).resolves.toBeNull();
    await expect(findForwardedWorkspaceMember(otherOrganizationId, people.outsider.email)).resolves.toBeNull();
    for (const email of [people.outsider.email, people.unverified.email, people.banned.email]) {
      await expect(findForwardedWorkspaceMember(legacyProjectId, email)).resolves.toBeNull();
    }
  });

  it("claims an assertion ID once until it expires", async () => {
    const jti = `assertion-${tag}`;
    const expiresAt = new Date(Date.now() + 60_000);

    await expect(claimLegacyMcpForwardAssertion(jti, expiresAt)).resolves.toBe(true);
    await expect(claimLegacyMcpForwardAssertion(jti, expiresAt)).resolves.toBe(false);
  });

  it("forgets assertion IDs once they have expired", async () => {
    const jti = `expired-${tag}`;
    await expect(claimLegacyMcpForwardAssertion(jti, new Date(Date.now() - 1_000))).resolves.toBe(true);

    await expect(claimLegacyMcpForwardAssertion(`other-${tag}`, new Date(Date.now() + 60_000))).resolves.toBe(true);
    await expect(claimLegacyMcpForwardAssertion(jti, new Date(Date.now() + 60_000))).resolves.toBe(true);
  });
});
