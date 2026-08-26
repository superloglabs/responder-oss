import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import {
  claimIssuePullRequestForRemediation,
  listStaleCreatingIssuePullRequests,
  markIssuePullRequestStarted,
  pullRequestActivityEvent,
  queueAutomaticIssuePullRequests,
  queueManualIssuePullRequest,
  recoverAbandonedIssuePullRequest,
} from "./pull-requests.js";
import {
  activeIssuePullRequestIndexPredicate,
  issuePullRequestActivities,
  issuePullRequests,
} from "./schema.js";

vi.mock("./client.js", () => ({
  getDatabase: vi.fn(),
}));

const issueId = "10101010-1010-4010-8010-101010101010";
const organizationId = "15151515-1515-4515-8515-151515151515";
const investigationId = "16161616-1616-4616-8616-161616161616";
const agentConfigVersionId = "08080808-0808-4808-8808-080808080808";
const remediationId = "09090909-0909-4909-8909-090909090909";
const codeRemediation = {
  id: remediationId,
  type: "code_change" as const,
  title: "Handle the missing value",
  description: "Guard the optional value before using it.",
  diff: "diff --git a/src/route.ts b/src/route.ts\n--- a/src/route.ts\n+++ b/src/route.ts\n@@ -1 +1 @@\n-old\n+new",
};

function simpleSelect(
  rows: unknown[],
  limit = vi.fn().mockResolvedValue(rows),
) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit })),
    })),
  };
}

function joinedSelect(
  rows: unknown[],
  where = vi.fn(() => ({
    orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
  })),
) {
  const limit = vi.fn().mockResolvedValue(rows);
  where.mockImplementation(() => ({
    orderBy: vi.fn(() => ({ limit })),
  }));
  const joined = {
    innerJoin: vi.fn(),
    where,
  };
  joined.innerJoin.mockReturnValue(joined);
  return { from: vi.fn(() => joined), where };
}

function databaseDouble(
  inserted: Array<{ id: string }>,
  options: {
    activeIndexAvailable?: boolean;
    existing?: Array<{ id: string }>;
  } = {},
) {
  const activeIndexAvailable = options.activeIndexAvailable ?? true;
  const existingLimit = vi.fn().mockResolvedValue(options.existing ?? []);
  const returning = vi.fn().mockResolvedValue(inserted);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing, returning }));
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ available: activeIndexAvailable }] })
    .mockResolvedValue({ rows: [] });
  const eligibilityWhere = vi.fn();
  const transaction = vi.fn(async (callback) => {
    const eligible = joinedSelect(
      [{ investigationId, agentConfigVersionId }],
      eligibilityWhere,
    );
    const select = vi
      .fn()
      .mockReturnValueOnce(
        simpleSelect([{ id: issueId, remediations: [codeRemediation] }]),
      )
      .mockReturnValueOnce(simpleSelect(options.existing ?? [], existingLimit))
      .mockReturnValueOnce(eligible);
    return callback({
      execute,
      insert: vi.fn(() => ({ values })),
      select,
    });
  });
  vi.mocked(getDatabase).mockReturnValue({ transaction } as never);
  return {
    eligibilityWhere,
    execute,
    existingLimit,
    onConflictDoNothing,
    returning,
  };
}

function compiledSql(statement: unknown) {
  return new PgDialect().sqlToQuery(statement as never);
}

describe("pull request activity storage", () => {
  it("deduplicates externally sourced activity within a request", () => {
    const index = getTableConfig(issuePullRequestActivities).indexes.find(
      (candidate) =>
        candidate.config.name === "issue_pull_request_activities_external_key_idx",
    );

    expect(index?.config.unique).toBe(true);
    expect(
      index?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["request_id", "external_key"]);
    expect(new PgDialect().sqlToQuery(index?.config.where as never).sql).toBe(
      '"issue_pull_request_activities"."external_key" is not null',
    );
  });

  it("timestamps activity at the event source", () => {
    expect(
      pullRequestActivityEvent(
        "review.comment.received",
        { body: "Please use silver petals." },
        new Date("2026-08-25T10:00:00.000Z"),
      ),
    ).toEqual({
      data: { body: "Please use silver petals." },
      meta: { at: "2026-08-25T10:00:00.000Z" },
      type: "review.comment.received",
    });
  });
});

describe("manual pull request uniqueness", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("enforces one active pull request request for each issue", () => {
    const index = getTableConfig(issuePullRequests).indexes.find(
      (candidate) =>
        candidate.config.name === "issue_pull_requests_active_issue_idx",
    );

    expect(index?.config.unique).toBe(true);
    expect(
      index?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["issue_id"]);
    expect(index?.config.where).toBe(activeIssuePullRequestIndexPredicate);
    expect(
      new PgDialect().sqlToQuery(activeIssuePullRequestIndexPredicate).sql,
    ).toBe(`"status" in ('queued', 'creating', 'created')`);
  });

  it("returns the request that wins the atomic insert", async () => {
    const requestId = "05050505-0505-4505-8505-050505050505";
    const { execute, onConflictDoNothing } = databaseDouble([{ id: requestId }]);

    await expect(
      queueManualIssuePullRequest({ issueId, organizationId, remediationId }),
    ).resolves.toEqual({ id: requestId });
    expect(execute).toHaveBeenCalledOnce();
    expect(compiledSql(execute.mock.calls[0]![0])).toMatchObject({
      params: ["public.issue_pull_requests_active_issue_idx"],
    });
    expect(compiledSql(execute.mock.calls[0]![0]).sql).toContain(
      "and indisunique",
    );
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: issuePullRequests.issueId,
      where: activeIssuePullRequestIndexPredicate,
    });
  });

  it("allows a failed automatic pull request to be retried", async () => {
    const requestId = "05050505-0505-4505-8505-050505050505";
    const { eligibilityWhere } = databaseDouble([{ id: requestId }]);

    await queueManualIssuePullRequest({ issueId, organizationId, remediationId });

    expect(compiledSql(eligibilityWhere.mock.calls[0]![0]).params).toEqual([
      issueId,
      organizationId,
      true,
      "manual",
      "always",
    ]);
  });

  it("rejects a concurrent request that loses the atomic insert", async () => {
    databaseDouble([]);

    await expect(
      queueManualIssuePullRequest({ issueId, organizationId, remediationId }),
    ).rejects.toMatchObject({
      code: "already_requested",
      message: "A pull request has already been requested for this issue",
    });
  });

  it("serializes and inserts without ON CONFLICT before the index exists", async () => {
    const requestId = "05050505-0505-4505-8505-050505050505";
    const {
      execute,
      existingLimit,
      onConflictDoNothing,
      returning,
    } = databaseDouble([{ id: requestId }], { activeIndexAvailable: false });

    await expect(
      queueManualIssuePullRequest({ issueId, organizationId, remediationId }),
    ).resolves.toEqual({ id: requestId });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(compiledSql(execute.mock.calls[1]![0]).sql).toBe(
      'lock table "issue_pull_requests" in access exclusive mode',
    );
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(
      existingLimit.mock.invocationCallOrder[0]!,
    );
    expect(onConflictDoNothing).not.toHaveBeenCalled();
    expect(returning).toHaveBeenCalledOnce();
  });

  it("rechecks for an active request after acquiring the compatibility lock", async () => {
    const existingRequestId = "06060606-0606-4606-8606-060606060606";
    const { execute, onConflictDoNothing, returning } = databaseDouble([], {
      activeIndexAvailable: false,
      existing: [{ id: existingRequestId }],
    });

    await expect(
      queueManualIssuePullRequest({ issueId, organizationId, remediationId }),
    ).rejects.toMatchObject({
      code: "already_requested",
      message: "A pull request has already been requested for this issue",
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(onConflictDoNothing).not.toHaveBeenCalled();
    expect(returning).not.toHaveBeenCalled();
  });
});

describe("remediation request state transitions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function updateDouble(rows: Array<{ id: string }>) {
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn((condition: unknown) => {
      void condition;
      return { returning };
    });
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where })),
      })),
    } as never);
    return { where };
  }

  it("claims only a queued request before placing it on the exclusive queue", async () => {
    const requestId = "05050505-0505-4505-8505-050505050505";
    const { where } = updateDouble([{ id: requestId }]);

    await claimIssuePullRequestForRemediation(requestId);

    expect(compiledSql(where.mock.calls[0]![0]).params).toEqual([
      requestId,
      "queued",
    ]);
  });

  it("lets the assigned worker continue an already-creating request", async () => {
    const requestId = "05050505-0505-4505-8505-050505050505";
    const { where } = updateDouble([{ id: requestId }]);

    await markIssuePullRequestStarted(requestId);

    expect(compiledSql(where.mock.calls[0]![0]).params).toEqual([
      requestId,
      "queued",
      "creating",
    ]);
  });

  it("rejects a losing enqueue claim", async () => {
    updateDouble([]);

    await expect(
      claimIssuePullRequestForRemediation(
        "05050505-0505-4505-8505-050505050505",
      ),
    ).rejects.toMatchObject({ code: "request_not_found" });
  });

  it("rejects an assigned worker starting an inactive request", async () => {
    updateDouble([]);

    await expect(
      markIssuePullRequestStarted(
        "05050505-0505-4505-8505-050505050505",
      ),
    ).rejects.toMatchObject({ code: "request_not_found" });
  });

  it("lists only creating requests older than the recovery cutoff", async () => {
    const staleBefore = new Date("2026-08-17T12:00:00.000Z");
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn((condition: unknown) => {
      void condition;
      return { limit };
    });
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    } as never);

    await listStaleCreatingIssuePullRequests(staleBefore);

    expect(compiledSql(where.mock.calls[0]![0]).params).toEqual([
      "creating",
      staleBefore.toISOString(),
    ]);
    expect(limit).toHaveBeenCalledWith(100);
  });

  it("atomically fails an abandoned request only while it remains stale", async () => {
    const requestId = "05050505-0505-4505-8505-050505050505";
    const staleBefore = new Date("2026-08-17T12:00:00.000Z");
    const returning = vi.fn().mockResolvedValue([{ id: requestId }]);
    const where = vi.fn((condition: unknown) => {
      void condition;
      return { returning };
    });
    const set = vi.fn(() => ({ where }));
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({ set })),
    } as never);

    await expect(
      recoverAbandonedIssuePullRequest(requestId, staleBefore),
    ).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      failureReason: "Remediation worker stopped before recording a result",
      status: "failed",
    }));
    expect(compiledSql(where.mock.calls[0]![0]).params).toEqual([
      requestId,
      "creating",
      staleBefore.toISOString(),
    ]);
  });
});

function automaticTransactionDouble(options: {
  activeIndexAvailable: boolean;
  existing?: Array<{ issueId: string }>;
  inserted: Array<{ id: string; issueId: string }>;
}) {
  const returning = vi.fn().mockResolvedValue(options.inserted);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing, returning }));
  const existingWhere = vi.fn().mockResolvedValue(options.existing ?? []);
  const execute = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [{ available: options.activeIndexAvailable }],
    })
    .mockResolvedValue({ rows: [] });
  const tx = {
    execute,
    insert: vi.fn(() => ({ values })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: existingWhere })),
    })),
  };
  return {
    execute,
    existingWhere,
    onConflictDoNothing,
    returning,
    tx,
    values,
  };
}

describe("automatic pull request uniqueness", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns only contenders inserted through the active partial index", async () => {
    const secondIssueId = "20202020-2020-4020-8020-202020202020";
    const winningRequest = {
      id: "05050505-0505-4505-8505-050505050505",
      issueId,
    };
    const { existingWhere, onConflictDoNothing, tx, values } =
      automaticTransactionDouble({
        activeIndexAvailable: true,
        inserted: [winningRequest],
      });

    await expect(
      queueAutomaticIssuePullRequests(tx as never, {
        agentConfigVersionId,
        investigationId,
        remediations: [
          { issueId, remediationId },
          { issueId: secondIssueId, remediationId },
        ],
      }),
    ).resolves.toEqual([winningRequest]);

    expect(values).toHaveBeenCalledWith([
      { agentConfigVersionId, investigationId, issueId, remediationId },
      { agentConfigVersionId, investigationId, issueId: secondIssueId, remediationId },
    ]);
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: issuePullRequests.issueId,
      where: activeIssuePullRequestIndexPredicate,
    });
    const activeRequestQuery = compiledSql(existingWhere.mock.calls[0]![0]);
    expect(activeRequestQuery.params).toEqual([
      issueId,
      secondIssueId,
      "queued",
      "creating",
      "created",
    ]);
    expect(activeRequestQuery.params).not.toContain("merged");
  });

  it("serializes before checking and inserts only missing requests pre-migration", async () => {
    const secondIssueId = "20202020-2020-4020-8020-202020202020";
    const inserted = [{
      id: "05050505-0505-4505-8505-050505050505",
      issueId: secondIssueId,
    }];
    const {
      execute,
      existingWhere,
      onConflictDoNothing,
      tx,
      values,
    } = automaticTransactionDouble({
      activeIndexAvailable: false,
      existing: [{ issueId }],
      inserted,
    });

    await expect(
      queueAutomaticIssuePullRequests(tx as never, {
        agentConfigVersionId,
        investigationId,
        remediations: [
          { issueId, remediationId },
          { issueId: secondIssueId, remediationId },
        ],
      }),
    ).resolves.toEqual(inserted);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(compiledSql(execute.mock.calls[1]![0]).sql).toBe(
      'lock table "issue_pull_requests" in access exclusive mode',
    );
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(
      existingWhere.mock.invocationCallOrder[0]!,
    );
    expect(values).toHaveBeenCalledWith([
      { agentConfigVersionId, investigationId, issueId: secondIssueId, remediationId },
    ]);
    expect(onConflictDoNothing).not.toHaveBeenCalled();
  });
});
