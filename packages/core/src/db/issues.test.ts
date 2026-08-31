import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import { searchIssuesByText, submitInvestigationReport } from "./issues.js";
import { queueAutomaticIssuePullRequests } from "./pull-requests.js";
import { investigations } from "./schema.js";

vi.mock("./client.js", () => ({
  getDatabase: vi.fn(),
}));

vi.mock("./pull-requests.js", () => ({
  getIssuePullRequestState: vi.fn(),
  queueAutomaticIssuePullRequests: vi.fn(),
}));

const investigationId = "16161616-1616-4616-8616-161616161616";
const organizationId = "15151515-1515-4515-8515-151515151515";
const agentConfigVersionId = "08080808-0808-4808-8808-080808080808";
const firstIssueId = "10101010-1010-4010-8010-101010101010";
const secondIssueId = "20202020-2020-4020-8020-202020202020";
const firstRemediationId = "11111111-1111-4111-8111-111111111111";
const secondRemediationId = "22222222-2222-4222-8222-222222222222";

function databaseDouble(status = "investigating") {
  const forUpdate = vi.fn().mockResolvedValue([{
    id: investigationId,
    status,
    agentConfigVersionId,
    prMode: "always",
  }]);
  const investigationSelect = {
    innerJoin: vi.fn(),
    where: vi.fn(() => ({
      limit: vi.fn(() => ({ for: forUpdate })),
    })),
  };
  investigationSelect.innerJoin.mockReturnValue(investigationSelect);

  const existingIssueWhere = vi.fn().mockResolvedValue([
    {
      id: firstIssueId,
      title: "First issue",
      description: "First issue description",
      severity: "SEV-2",
      remediation: "Fix the first issue",
      remediations: [{
        id: firstRemediationId,
        type: "code_change",
        title: "Fix the first issue",
        description: "Fix the first issue",
        changes: [{ repository: null, diff: "diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n-old\n+new" }],
      }],
    },
    {
      id: secondIssueId,
      title: "Second issue",
      description: "Second issue description",
      severity: "SEV-3",
      remediation: "Fix the second issue",
      remediations: [{
        id: secondRemediationId,
        type: "code_change",
        title: "Fix the second issue",
        description: "Fix the second issue",
        changes: [{ repository: null, diff: "diff --git a/second.ts b/second.ts\n--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-old\n+new" }],
      }],
    },
  ]);
  const select = vi
    .fn()
    .mockReturnValueOnce({ from: vi.fn(() => investigationSelect) })
    .mockReturnValueOnce({
      from: vi.fn(() => ({ where: existingIssueWhere })),
    });
  const investigationIssueValues = vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn().mockResolvedValue([]);
  const tx = {
    insert: vi.fn(() => ({ values: investigationIssueValues })),
    select,
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: updateWhere })),
    })),
  };
  const transaction = vi.fn(async (callback) => callback(tx));
  vi.mocked(getDatabase).mockReturnValue({ transaction } as never);
  return { forUpdate, tx };
}

describe("automatic pull requests from investigation reports", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns issue and request IDs only for inserts that won a conflict", async () => {
    const { forUpdate, tx } = databaseDouble();
    const requestId = "05050505-0505-4505-8505-050505050505";
    vi.mocked(queueAutomaticIssuePullRequests).mockResolvedValue([{
      id: requestId,
      issueId: secondIssueId,
    }]);
    const evidence = [{
      source: "other" as const,
      title: "Observed failure",
      detail: "The failure recurred during this investigation.",
    }];

    const result = await submitInvestigationReport({
      investigationId,
      organizationId,
      submission: {
        newIssueEmbeddings: [],
        report: {
          schemaVersion: 1,
          headline: "Two issues recurred",
          summary: "Only one automatic request won its concurrent insert.",
          issues: [
            {
              evidence,
              issueId: firstIssueId,
              resolution: "existing",
            },
            {
              evidence,
              issueId: secondIssueId,
              resolution: "existing",
            },
          ],
        },
      },
    });

    expect(queueAutomaticIssuePullRequests).toHaveBeenCalledWith(tx, {
      agentConfigVersionId,
      investigationId,
      remediations: [
        { issueId: firstIssueId, remediationId: firstRemediationId },
        { issueId: secondIssueId, remediationId: secondRemediationId },
      ],
    });
    expect(result.automaticPullRequestIssueIds).toEqual([secondIssueId]);
    expect(result.automaticPullRequestRequestIds).toEqual([requestId]);
    expect(forUpdate).toHaveBeenCalledWith("update", { of: investigations });
  });

  it("rejects a second report after the locked investigation is resolved", async () => {
    const { tx } = databaseDouble("resolved");
    const evidence = [{
      source: "other" as const,
      title: "Observed failure",
      detail: "The failure recurred during this investigation.",
    }];

    await expect(
      submitInvestigationReport({
        investigationId,
        organizationId,
        submission: {
          newIssueEmbeddings: [],
          report: {
            schemaVersion: 1,
            headline: "Duplicate report",
            summary: "This second submission must not write.",
            issues: [{
              evidence,
              issueId: firstIssueId,
              resolution: "existing",
            }],
          },
        },
      }),
    ).rejects.toThrow("Investigation report has already been submitted");
    expect(tx.insert).not.toHaveBeenCalled();
    expect(queueAutomaticIssuePullRequests).not.toHaveBeenCalled();
  });
});

describe("issue text search", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("searches root causes and timeline entries", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn((condition: unknown) => {
      void condition;
      return { orderBy };
    });
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    } as never);

    await searchIssuesByText(organizationId, "installation", 10);

    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never);
    expect(query.sql).toContain('"issues"."root_cause" ilike');
    expect(query.sql).toContain(
      'jsonb_array_elements("issues"."timeline") as timeline_entry',
    );
    expect(query.sql).toContain("timeline_entry->>'title' ilike");
    expect(query.sql).toContain("timeline_entry->>'description' ilike");
    expect(query.sql).not.toContain('"issues"."timeline"::text ilike');
  });
});
