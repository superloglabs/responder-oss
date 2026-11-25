import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organization } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import {
  pullRequestApprovalRequired,
  savePullRequestApprovalRequired,
} from "./pull-request-approval.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_PULL_REQUEST_APPROVAL_DATABASE_URL;
describe.skipIf(!testUrl)("pull request approval setting (PostgreSQL)", () => {
  const organizationId = randomUUID();

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    await getDatabase().insert(organization).values({
      createdAt: new Date("2026-11-25T12:00:00.000Z"),
      id: organizationId,
      name: "Approval workspace",
      slug: organizationId,
    });
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(eq(organization.id, organizationId));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("is off until an administrator turns it on, and can be turned off again", async () => {
    expect(await pullRequestApprovalRequired(organizationId)).toBe(false);
    await savePullRequestApprovalRequired(organizationId, true);
    expect(await pullRequestApprovalRequired(organizationId)).toBe(true);
    await savePullRequestApprovalRequired(organizationId, false);
    expect(await pullRequestApprovalRequired(organizationId)).toBe(false);
  });
});
