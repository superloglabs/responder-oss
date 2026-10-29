import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDatabase, closeDatabase } from "./client.js";
import { organization } from "./auth-schema.js";
import {
  claimErrorIssue,
  errorIssueActivity,
  findErrorIssue,
  listErrorIssues,
  postErrorIssueUpdate,
  recordErrorOccurrences,
  releaseErrorIssue,
  setErrorIssueStatus,
  type ErrorIssueClaimant,
} from "./error-issues.js";
import { groupErrorCandidates } from "../telemetry/error-issues.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_ERROR_ISSUE_DATABASE_URL;
describe.skipIf(!testUrl)("error issue claims (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const user = { id: randomUUID(), name: "Ash" };
  const claimant = (agent: string, credential = "oauth:claude-code"): ErrorIssueClaimant => ({
    actor: { agent, client: "Claude Code", user },
    credential,
  });
  const app = { agent: null, client: null, user };

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "4");
    await getDatabase().insert(organization).values({ id: organizationId, name: "Claim test", slug: organizationId, createdAt: new Date() });
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(eq(organization.id, organizationId));
    await closeDatabase(); vi.unstubAllEnvs();
  });

  async function newIssue(): Promise<string> {
    const message = randomUUID();
    const [occurrences] = groupErrorCandidates([{
      attrs: {}, resource_attrs: {}, body: "", candidate_id: randomUUID(), discovered_ms: String(Date.now()),
      exception_message: message, exception_stacktrace: "", exception_type: `ClaimError_${message}`, kind: "log",
      project_id: organizationId, seen_ms: String(Date.now()), service: "api", severity: "ERROR", span_id: "", span_name: "", trace_id: "",
    }]);
    const { issueId } = await getDatabase().transaction((tx) => recordErrorOccurrences(tx, occurrences!));
    return issueId;
  }

  it("keeps a claim for its claimant until someone takes it over", async () => {
    const issueId = await newIssue();
    const first = await claimErrorIssue(organizationId, issueId, claimant("first"), { message: "Looking" });
    expect(first).toMatchObject({ ok: true, issue: { claim: { agent: "first", credential: "oauth:claude-code" } } });
    expect(await claimErrorIssue(organizationId, issueId, claimant("first"))).toMatchObject({ ok: true });

    const blocked = await claimErrorIssue(organizationId, issueId, claimant("second"));
    expect(blocked).toMatchObject({ ok: false, claim: { agent: "first" } });
    // The same agent name through another credential is someone else.
    expect(await claimErrorIssue(organizationId, issueId, claimant("first", "api_key:other"))).toMatchObject({ ok: false });

    const taken = await claimErrorIssue(organizationId, issueId, claimant("second"), { takeOver: true });
    expect(taken).toMatchObject({ ok: true, issue: { claim: { agent: "second" } } });

    const { activity } = await errorIssueActivity(issueId);
    expect(activity.map((entry) => [entry.type, entry.actor.agent, entry.message])).toEqual([
      ["claimed", "first", "Looking"],
      ["claimed", "second", "Took over from first via Claude Code for Ash"],
    ]);
  });

  it("lets one of two simultaneous claims win", async () => {
    const issueId = await newIssue();
    const results = await Promise.all([
      claimErrorIssue(organizationId, issueId, claimant("a")),
      claimErrorIssue(organizationId, issueId, claimant("b")),
    ]);
    expect(results.filter((result) => result?.ok)).toHaveLength(1);
    expect((await errorIssueActivity(issueId)).activity).toHaveLength(1);
  });

  it("releases only the holder's claim, unless released from the app", async () => {
    const issueId = await newIssue();
    await claimErrorIssue(organizationId, issueId, claimant("holder"));
    expect(await releaseErrorIssue(organizationId, issueId, claimant("other").actor, { holder: claimant("other") }))
      .toMatchObject({ ok: false, claim: { agent: "holder" } });
    expect(await releaseErrorIssue(organizationId, issueId, app)).toMatchObject({ ok: true, issue: { claim: null } });
    expect(await releaseErrorIssue(organizationId, issueId, app)).toMatchObject({ ok: true });
    expect((await errorIssueActivity(issueId)).activity.map((entry) => entry.type)).toEqual(["claimed", "released"]);
  });

  it("lists each linked pull request once, from its first link", async () => {
    const issueId = await newIssue();
    const url = "https://github.com/acme/api/pull/7";
    await postErrorIssueUpdate(organizationId, issueId, claimant("fixer").actor, { message: "Opened the fix", pullRequestUrl: url });
    await postErrorIssueUpdate(organizationId, issueId, claimant("fixer").actor, { message: "Addressed review" });
    await postErrorIssueUpdate(organizationId, issueId, claimant("fixer").actor, { message: "Rebased", pullRequestUrl: url });
    const { activity, pullRequests } = await errorIssueActivity(issueId);
    expect(activity).toHaveLength(3);
    expect(pullRequests).toEqual([{ linkedAt: activity[0]!.createdAt, url }]);
    expect(await postErrorIssueUpdate(randomUUID(), issueId, app, { message: "Elsewhere" })).toBeNull();
  });

  it("ends the claim when the issue is resolved, and records only real changes", async () => {
    const issueId = await newIssue();
    await claimErrorIssue(organizationId, issueId, claimant("fixer"));
    expect(await listErrorIssues(organizationId, { claimed: true, limit: 100 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: issueId })]),
    );

    const resolved = await setErrorIssueStatus(organizationId, issueId, "resolved", { actor: claimant("fixer").actor, message: "Fixed in #7" });
    expect(resolved).toMatchObject({ claim: null, status: "resolved" });
    const statusChangedAt = resolved!.statusChangedAt;
    await setErrorIssueStatus(organizationId, issueId, "resolved", { actor: app });
    expect((await findErrorIssue(organizationId, issueId))!.statusChangedAt).toBe(statusChangedAt);
    expect(await listErrorIssues(organizationId, { claimed: false, limit: 100, status: "resolved" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: issueId })]),
    );

    const { activity } = await errorIssueActivity(issueId);
    expect(activity.map((entry) => [entry.type, entry.status, entry.message])).toEqual([
      ["claimed", null, null],
      ["status", "resolved", "Fixed in #7"],
    ]);
  });
});
