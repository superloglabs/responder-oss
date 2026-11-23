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
  agentConfigVersions,
  agents,
  automationRuns,
  automations,
  automationVersions,
  integrationAccounts,
  investigations,
  issuePullRequests,
  issues,
  pullRequestOrigins,
  repositories,
  suggestionPullRequests,
  suggestions,
} from "./schema.js";

// A created issue pull request and suggestion pull request in the workspace.
async function seedCreatedPullRequests(
  organizationId: string,
  pullRequest: { pullRequestNumber: number; repositoryFullName: string },
): Promise<{ issuePullRequestId: string; suggestionPullRequestId: string }> {
  const database = getDatabase();
  const [agent] = await database
    .insert(agents)
    .values({ name: "Pull request origins", organizationId })
    .returning({ id: agents.id });
  const [version] = await database
    .insert(agentConfigVersions)
    .values({
      agentId: agent!.id,
      model: "gpt-5.4",
      prompt: "Investigate.",
      reportConfig: {} as typeof agentConfigVersions.$inferInsert["reportConfig"],
      trigger: "sentry_issue",
      triggerConfig: {} as typeof agentConfigVersions.$inferInsert["triggerConfig"],
      version: 1,
    })
    .returning({ id: agentConfigVersions.id });
  const [investigation] = await database
    .insert(investigations)
    .values({
      agentConfigVersionId: version!.id,
      agentId: agent!.id,
      input: {} as typeof investigations.$inferInsert["input"],
      organizationId,
      title: "Pull request origins",
    })
    .returning({ id: investigations.id });
  const [issue] = await database
    .insert(issues)
    .values({
      description: "",
      organizationId,
      remediation: "",
      severity: "SEV-3",
      title: "Pull request origins",
    })
    .returning({ id: issues.id });
  const [suggestion] = await database
    .insert(suggestions)
    .values({
      agentConfigVersionId: version!.id,
      detail: "",
      fingerprint: randomUUID(),
      investigationId: investigation!.id,
      organizationId,
      subtitle: "",
      title: "Pull request origins",
    })
    .returning({ id: suggestions.id });
  const created = {
    ...pullRequest,
    agentConfigVersionId: version!.id,
    investigationId: investigation!.id,
    status: "created" as const,
  };
  const [issuePullRequest] = await database
    .insert(issuePullRequests)
    .values({ ...created, issueId: issue!.id })
    .returning({ id: issuePullRequests.id });
  const [suggestionPullRequest] = await database
    .insert(suggestionPullRequests)
    .values({ ...created, suggestionId: suggestion!.id })
    .returning({ id: suggestionPullRequests.id });
  return {
    issuePullRequestId: issuePullRequest!.id,
    suggestionPullRequestId: suggestionPullRequest!.id,
  };
}

async function pullRequestStatuses(ids: { issuePullRequestId: string; suggestionPullRequestId: string }) {
  const database = getDatabase();
  const [issuePullRequest] = await database
    .select({ status: issuePullRequests.status })
    .from(issuePullRequests)
    .where(eq(issuePullRequests.id, ids.issuePullRequestId));
  const [suggestionPullRequest] = await database
    .select({ status: suggestionPullRequests.status })
    .from(suggestionPullRequests)
    .where(eq(suggestionPullRequests.id, ids.suggestionPullRequestId));
  return { issue: issuePullRequest?.status, suggestion: suggestionPullRequest?.status };
}

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_PULL_REQUEST_ORIGINS_DATABASE_URL;
describe.skipIf(!testUrl)("pull request origins (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const pullRequest = { pullRequestNumber: 7, repositoryFullName: "acme/widgets" };
  const held = { installationId: 111, repositoryId: 456 };
  // The workspace's connection to installation 333 failed.
  const disconnected = { installationId: 333, repositoryId: 777 };
  // Neither workspace holds these pairs, though each ID is held somewhere.
  const notHeld = [
    { installationId: 222, repositoryId: 999 },
    { installationId: 111, repositoryId: 999 },
    { installationId: 222, repositoryId: 456 },
    disconnected,
  ];
  let runId: string;
  let workspacePullRequests: Awaited<ReturnType<typeof seedCreatedPullRequests>>;
  let otherWorkspacePullRequests: Awaited<ReturnType<typeof seedCreatedPullRequests>>;

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
    const [failedAccount] = await database
      .insert(integrationAccounts)
      .values({
        displayName: "acme",
        externalAccountId: String(disconnected.installationId),
        organizationId,
        provider: "github",
        status: "error",
      })
      .returning({ id: integrationAccounts.id });
    await database.insert(repositories).values({
      available: false,
      externalId: String(disconnected.repositoryId),
      fullName: pullRequest.repositoryFullName,
      integrationAccountId: failedAccount!.id,
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
    workspacePullRequests = await seedCreatedPullRequests(organizationId, pullRequest);
    // The other workspace has pull requests with the same name and number.
    otherWorkspacePullRequests = await seedCreatedPullRequests(otherOrganizationId, pullRequest);
  });
  afterAll(async () => {
    const database = getDatabase();
    const organizationIds = [organizationId, otherOrganizationId];
    await database.delete(suggestions).where(inArray(suggestions.organizationId, organizationIds));
    await database.delete(investigations).where(inArray(investigations.organizationId, organizationIds));
    await database.delete(organization).where(inArray(organization.id, organizationIds));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("finds the run only for the installation and repository its workspace holds", async () => {
    await expect(findPullRequestReviewTarget({ ...pullRequest, ...held })).resolves.toMatchObject({
      automationRun: { id: runId },
      organizationId,
    });
    // The same name in another installation or repository, or a failed connection.
    for (const ids of notHeld) {
      await expect(findPullRequestReviewTarget({ ...pullRequest, ...ids })).resolves.toBeNull();
    }
  });

  it("records a merge only for the installation and repository its workspace holds", async () => {
    for (const ids of notHeld) {
      await expect(markPullRequestOriginMerged({ ...pullRequest, ...ids })).resolves.toBe(false);
    }
    const [before] = await getDatabase()
      .select({ mergedAt: pullRequestOrigins.mergedAt })
      .from(pullRequestOrigins)
      .where(eq(pullRequestOrigins.automationRunId, runId));
    expect(before?.mergedAt).toBeNull();

    await expect(markPullRequestOriginMerged({ ...pullRequest, ...held })).resolves.toBe(true);
  });

  it("merges issue and suggestion pull requests only for the IDs their workspace holds", async () => {
    for (const ids of notHeld.filter((pair) => pair.installationId !== 222 || pair.repositoryId !== 999)) {
      await expect(markIssuePullRequestMerged({ ...pullRequest, ...ids })).resolves.toBeNull();
      await expect(markSuggestionPullRequestMerged({ ...pullRequest, ...ids })).resolves.toBeNull();
    }
    await expect(pullRequestStatuses(workspacePullRequests))
      .resolves.toEqual({ issue: "created", suggestion: "created" });
    await expect(pullRequestStatuses(otherWorkspacePullRequests))
      .resolves.toEqual({ issue: "created", suggestion: "created" });

    await expect(markIssuePullRequestMerged({ ...pullRequest, ...held })).resolves.toMatchObject({
      organizationId,
      requestId: workspacePullRequests.issuePullRequestId,
    });
    await expect(markSuggestionPullRequestMerged({ ...pullRequest, ...held })).resolves.toMatchObject({
      organizationId,
      requestId: workspacePullRequests.suggestionPullRequestId,
    });
    await expect(pullRequestStatuses(workspacePullRequests))
      .resolves.toEqual({ issue: "merged", suggestion: "merged" });
    // The other workspace's pull requests of the same name stay as they were.
    await expect(pullRequestStatuses(otherWorkspacePullRequests))
      .resolves.toEqual({ issue: "created", suggestion: "created" });

    // The other workspace's own IDs merge only its pull requests.
    await expect(markIssuePullRequestMerged({ ...pullRequest, installationId: 222, repositoryId: 999 }))
      .resolves.toMatchObject({
        organizationId: otherOrganizationId,
        requestId: otherWorkspacePullRequests.issuePullRequestId,
      });
    await expect(markSuggestionPullRequestMerged({ ...pullRequest, installationId: 222, repositoryId: 999 }))
      .resolves.toMatchObject({
        organizationId: otherOrganizationId,
        requestId: otherWorkspacePullRequests.suggestionPullRequestId,
      });
    await expect(pullRequestStatuses(otherWorkspacePullRequests))
      .resolves.toEqual({ issue: "merged", suggestion: "merged" });
  });
});
