import { getTableConfig } from "drizzle-orm/pg-core";
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

function databaseDouble(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const innerJoin = vi.fn();
  const query = {
    innerJoin,
    where: vi.fn(() => ({ limit })),
  };
  innerJoin.mockReturnValue(query);
  const finalWhere = vi.fn().mockResolvedValue(undefined);
  const returning = vi.fn().mockResolvedValue([{ id: scope.requestId }]);
  const update = vi.fn()
    .mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning })),
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
}

describe("Linear ticket requests", () => {
  afterEach(() => vi.clearAllMocks());

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
    databaseDouble([request]);
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
  });
});
