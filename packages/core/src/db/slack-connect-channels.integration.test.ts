import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organization, user } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import {
  claimSlackConnectChannel,
  getOrganizationName,
  getUserEmail,
  updateSlackConnectChannel,
} from "./slack-connect-channels.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_SLACK_CONNECT_DATABASE_URL;
describe.skipIf(!testUrl)("Slack Connect channels (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    const db = getDatabase();
    await db.insert(organization).values({ createdAt: new Date(), id: organizationId, name: "Acme", slug: organizationId });
    await db.insert(user).values({ email: `${userId}@acme.example`, id: userId, name: "Member" });
  });
  afterAll(async () => {
    const db = getDatabase();
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("keeps one channel per workspace and records its progress", async () => {
    const [first, second] = await Promise.all([
      claimSlackConnectChannel(organizationId),
      claimSlackConnectChannel(organizationId),
    ]);
    expect(first).toMatchObject({ channelId: null, organizationId, status: "pending" });
    expect(second.organizationId).toBe(organizationId);

    await updateSlackConnectChannel(organizationId, { channelId: "C1", channelName: "acme-superlog" });
    await updateSlackConnectChannel(organizationId, { lastError: null, status: "joined" });
    expect(await claimSlackConnectChannel(organizationId)).toMatchObject({
      channelId: "C1",
      channelName: "acme-superlog",
      status: "joined",
    });
    await expect(updateSlackConnectChannel(organizationId, { status: "bogus" as never })).rejects.toThrow();

    expect(await getOrganizationName(organizationId)).toBe("Acme");
    expect(await getUserEmail(userId)).toBe(`${userId}@acme.example`);
  });
});
