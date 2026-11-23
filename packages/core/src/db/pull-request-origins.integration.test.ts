import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organization } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import {
  findPullRequestReviewTarget,
  markPullRequestOriginMerged,
  recordPullRequestOrigin,
} from "./pull-request-origins.js";
import { markIssuePullRequestMerged } from "./pull-requests.js";
import { markSuggestionPullRequestMerged } from "./suggestion-pull-requests.js";
import {
  automationRuns,
  automations,
  automationVersions,
  integrationAccounts,
  pullRequestOrigins,
  repositories,
} from "./schema.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_PULL_REQUEST_ORIGINS_DATABASE_URL;
describe.skipIf(!testUrl)("pull request origins (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const pullRequest = { pullRequestNumber: 7, repositoryFullName: "acme/widgets" };
  const held = { installationId: 111, repositoryId: 456 };
  let runId: string;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    const database = getDatabase();
    await database.insert(organization).values([organizationId, otherOrganizationId].map((id) => ({
      createdAt: new Date(),
      id,
      name: "Pull request origins test",
      slug: id,
    })));
    const [account] = await database
      .insert(integrationAccounts)
      .values({
        displayName: "acme",
        externalAccountId: String(held.installationId),
        organizationId,
        provider: "github",
      })
      .returning({ id: integrationAccounts.id });
    await database.insert(repositories).values({
      externalId: String(held.repositoryId),
      fullName: pullRequest.repositoryFullName,
      integrationAccountId: account!.id,
    });
    // Another workspace holds an unrelated installation.
    const [otherAccount] = await database
      .insert(integrationAccounts)
      .values({
        displayName: "acme",
        externalAccountId: "222",
        organizationId: otherOrganizationId,
        provider: "github",
      })
      .returning({ id: integrationAccounts.id });
    await database.insert(repositories).values({
      externalId: "999",
      fullName: pullRequest.repositoryFullName,
      integrationAccountId: otherAccount!.id,
    });

    const [automation] = await database
      .insert(automations)
      .values({ name: "Pull request origins", organizationId })
      .returning({ id: automations.id });
    const [version] = await database
      .insert(automationVersions)
      .values({
        automationId: automation!.id,
        harness: "codex",
        maxModelRequests: 10,
        maxOutputTokensPerRequest: 1000,
        maxRuntimeSeconds: 600,
        model: "gpt-5.4",
        modelProvider: "openai",
        prompt: "Open a pull request.",
        triggers: [],
        version: 1,
      })
      .returning({ id: automationVersions.id });
    const [run] = await database
      .insert(automationRuns)
      .values({
        automationId: automation!.id,
        automationVersionId: version!.id,
        organizationId,
        redactedTrigger: {},
        triggerInput: {},
      })
      .returning({ id: automationRuns.id });
    runId = run!.id;
    await recordPullRequestOrigin({ ...pullRequest, automationRunId: runId, organizationId });
  });
  afterAll(async () => {
    await getDatabase()
      .delete(organization)
      .where(inArray(organization.id, [organizationId, otherOrganizationId]));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("finds the run only for the installation and repository its workspace holds", async () => {
    await expect(findPullRequestReviewTarget({ ...pullRequest, ...held })).resolves.toMatchObject({
      automationRun: { id: runId },
      organizationId,
    });
    // The same name in another installation or repository.
    await expect(findPullRequestReviewTarget({ ...pullRequest, installationId: 222, repositoryId: 999 }))
      .resolves.toBeNull();
    await expect(findPullRequestReviewTarget({ ...pullRequest, installationId: 111, repositoryId: 999 }))
      .resolves.toBeNull();
  });

  it("records a merge only for the installation and repository its workspace holds", async () => {
    await expect(markPullRequestOriginMerged({ ...pullRequest, installationId: 222, repositoryId: 999 }))
      .resolves.toBe(false);
    const [before] = await getDatabase()
      .select({ mergedAt: pullRequestOrigins.mergedAt })
      .from(pullRequestOrigins)
      .where(eq(pullRequestOrigins.automationRunId, runId));
    expect(before?.mergedAt).toBeNull();

    await expect(markPullRequestOriginMerged({ ...pullRequest, ...held })).resolves.toBe(true);
  });

  it("matches issue and suggestion pull requests by the same IDs", async () => {
    // No issue or suggestion pull request exists; the queries must still run.
    await expect(markIssuePullRequestMerged({ ...pullRequest, ...held })).resolves.toBeNull();
    await expect(markSuggestionPullRequestMerged({ ...pullRequest, ...held })).resolves.toBeNull();
  });
});
