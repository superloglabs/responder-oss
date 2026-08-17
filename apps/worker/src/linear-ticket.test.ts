import { afterEach, describe, expect, it, vi } from "vitest";
import { fulfillLinearTicketRequest } from "@responder/core/db/linear-tickets";
import { createLinearTicketTool } from "./linear-ticket.js";

vi.mock("@responder/core/db/linear-tickets", () => ({
  fulfillLinearTicketRequest: vi.fn(),
}));

describe("Linear ticket tool", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("binds the write to the queued request instead of model output", async () => {
    vi.mocked(fulfillLinearTicketRequest).mockResolvedValue({
      id: "linear-issue-id",
      identifier: "OPS-42",
      url: "https://linear.app/example/issue/OPS-42/example",
    });
    const tool = createLinearTicketTool({
      agentConfigVersionId: "10000000-0000-4000-8000-000000000001",
      investigationId: "10000000-0000-4000-8000-000000000002",
      organizationId: "10000000-0000-4000-8000-000000000003",
      requestId: "10000000-0000-4000-8000-000000000004",
    });

    await expect(tool.invoke(
      undefined as never,
      JSON.stringify({
        projectId: "project-id",
        requestId: "90000000-0000-4000-8000-000000000099",
        teamId: "team-id",
      }),
    )).resolves.toMatchObject({
      created: true,
      linearIdentifier: "OPS-42",
    });
    expect(fulfillLinearTicketRequest).toHaveBeenCalledWith({
      agentConfigVersionId: "10000000-0000-4000-8000-000000000001",
      investigationId: "10000000-0000-4000-8000-000000000002",
      organizationId: "10000000-0000-4000-8000-000000000003",
      requestId: "10000000-0000-4000-8000-000000000004",
      teamId: "team-id",
      projectId: "project-id",
    });
  });
});
