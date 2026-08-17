import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLinearIssue,
  findLinearIssueById,
  renderLinearIssueDescription,
} from "../integrations/linear.js";
import { getDatabase } from "./client.js";
import { getRuntimeLinearConnection } from "./investigations.js";
import {
  fulfillLinearTicketRequest,
  listPendingLinearTicketRequests,
  LinearTicketError,
} from "./linear-tickets.js";
import { issueLinearTickets } from "./schema.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));
vi.mock("./investigations.js", () => ({
  getRuntimeLinearConnection: vi.fn(),
}));
vi.mock("../integrations/linear.js", () => ({
  createLinearIssue: vi.fn(),
  findLinearIssueById: vi.fn(),
  renderLinearIssueDescription: vi.fn(() => "Rendered description"),
}));

const scope = {
  agentConfigVersionId: "10000000-0000-4000-8000-000000000001",
  investigationId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  requestId: "10000000-0000-4000-8000-000000000004",
  teamId: "team-id",
};

const request = {
  id: scope.requestId,
  status: "pending" as const,
  integrationAccountId: "10000000-0000-4000-8000-000000000005",
  title: "Checkout returns 503",
  description: "The checkout route throws.",
  severity: "SEV-2" as const,
  remediation: "Handle the missing value.",
  evidence: [],
  issueId: "10000000-0000-4000-8000-000000000006",
  linearIssueTemplate: "{{description}}",
  linearIssueId: null,
  linearIdentifier: null,
  linearIssueUrl: null,
};

function databaseDouble(
  rows: unknown[],
  claimedRows: Array<{ id: string }> = [{ id: scope.requestId }],
) {
  const limit = vi.fn().mockResolvedValue(rows);
  const innerJoin = vi.fn();
  const query = {
    innerJoin,
    where: vi.fn(() => ({ limit })),
  };
  innerJoin.mockReturnValue(query);
  const finalWhere = vi.fn().mockResolvedValue(undefined);
  const returning = vi.fn().mockResolvedValue(claimedRows);
  const claimWhere = vi.fn((condition: unknown) => {
    void condition;
    return { returning };
  });
  const update = vi.fn()
    .mockReturnValueOnce({
      set: vi.fn(() => ({
        where: claimWhere,
      })),
    })
    .mockReturnValue({
      set: vi.fn(() => ({ where: finalWhere })),
    });
  vi.mocked(getDatabase).mockReturnValue({
    select: vi.fn(() => ({
      from: vi.fn(() => query),
    })),
    update,
  } as never);
  return { claimWhere };
}

function compiledSql(statement: unknown) {
  return new PgDialect().sqlToQuery(statement as never);
}

describe("Linear ticket requests", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("allows only one Linear ticket record per Responder issue", () => {
    const index = getTableConfig(issueLinearTickets).indexes.find(
      (candidate) => candidate.config.name === "issue_linear_tickets_issue_idx",
    );
    expect(index?.config.unique).toBe(true);
  });

  it("rejects a request outside the active investigation and organization", async () => {
    databaseDouble([]);
    await expect(fulfillLinearTicketRequest(scope)).rejects.toEqual(
      new LinearTicketError("Linear ticket request not found", "request_not_found"),
    );
    expect(getRuntimeLinearConnection).not.toHaveBeenCalled();
    expect(createLinearIssue).not.toHaveBeenCalled();
  });

  it("recovers a retry by looking up the stable request ID", async () => {
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const { claimWhere } = databaseDouble([request]);
    vi.mocked(getRuntimeLinearConnection).mockResolvedValue({
      accessToken: "linear-token",
      accountId: request.integrationAccountId,
      displayName: "Example Linear",
      mcpUrl: "https://mcp.linear.app/mcp",
    });
    vi.mocked(createLinearIssue).mockRejectedValue(new Error("Issue already exists"));
    vi.mocked(findLinearIssueById).mockResolvedValue({
      id: request.id,
      identifier: "OPS-42",
      url: "https://linear.app/example/issue/OPS-42/checkout-returns-503",
    });

    await expect(fulfillLinearTicketRequest(scope)).resolves.toMatchObject({
      identifier: "OPS-42",
    });
    expect(createLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      id: request.id,
      teamId: scope.teamId,
    }));
    expect(findLinearIssueById).toHaveBeenCalledWith({
      accessToken: "linear-token",
      issueId: request.id,
    });
    expect(renderLinearIssueDescription).toHaveBeenCalledOnce();
    expect(renderLinearIssueDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        issueBaseUrl: "https://responder.example",
      }),
    );
    expect(getRuntimeLinearConnection).toHaveBeenCalledWith(
      scope.agentConfigVersionId,
      request.integrationAccountId,
    );
    const claim = compiledSql(claimWhere.mock.calls[0]![0]);
    expect(claim.params).toEqual([
      request.id,
      "pending",
      "failed",
      6,
    ]);
    expect(claim.params).not.toContain("creating");
  });

  it("does not let a concurrent worker reclaim an active request", async () => {
    databaseDouble([request], []);

    await expect(fulfillLinearTicketRequest(scope)).rejects.toEqual(
      new LinearTicketError(
        "Linear ticket request is no longer active",
        "request_not_active",
      ),
    );
    expect(getRuntimeLinearConnection).not.toHaveBeenCalled();
    expect(createLinearIssue).not.toHaveBeenCalled();
  });

  it("does not expose active requests to duplicate jobs", async () => {
    const orderBy = vi.fn().mockResolvedValue([]);
    const where = vi.fn((condition: unknown) => {
      void condition;
      return { orderBy };
    });
    const joined = { innerJoin: vi.fn(), where };
    joined.innerJoin.mockReturnValue(joined);
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => joined),
      })),
    } as never);

    await expect(listPendingLinearTicketRequests({
      investigationId: scope.investigationId,
      organizationId: scope.organizationId,
    })).resolves.toEqual([]);

    const pending = compiledSql(where.mock.calls[0]![0]);
    expect(pending.params).toEqual([
      scope.investigationId,
      scope.organizationId,
      "pending",
      "failed",
      6,
    ]);
    expect(pending.params).not.toContain("creating");
  });
});
