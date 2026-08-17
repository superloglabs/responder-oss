import { afterEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import { submitInvestigationReport } from "./issues.js";
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
    },
    {
      id: secondIssueId,
      title: "Second issue",
      description: "Second issue description",
      severity: "SEV-3",
      remediation: "Fix the second issue",
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
      issueIds: [firstIssueId, secondIssueId],
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
