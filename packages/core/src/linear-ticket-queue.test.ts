import { describe, expect, it, vi } from "vitest";
import { getRuntimeAgentConfig } from "./db/investigations.js";
import { listLinearTicketRequestsForQueue } from "./db/linear-tickets.js";
import { linearTicketQueue } from "./jobs.js";
import {
  queueLinearTicketJob,
  queuePendingLinearTicketJobs,
} from "./linear-ticket-queue.js";

vi.mock("./db/investigations.js", () => ({
  getRuntimeAgentConfig: vi.fn(),
}));
vi.mock("./db/linear-tickets.js", () => ({
  listLinearTicketRequestsForQueue: vi.fn(),
}));

const input = {
  config: {
    agentId: "10000000-0000-4000-8000-000000000001",
    createLinearTickets: true,
    id: "10000000-0000-4000-8000-000000000002",
    linearIssueTemplate: "{{description}}",
    model: "gpt-5.6-sol",
    organizationId: "10000000-0000-4000-8000-000000000003",
    prMode: "disabled" as const,
    prompt: "Investigate.",
  },
  investigationId: "10000000-0000-4000-8000-000000000004",
  requestId: "10000000-0000-4000-8000-000000000005",
};

describe("Linear ticket queue", () => {
  it("uses the request ID as the durable singleton key", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    await expect(queueLinearTicketJob({ send }, input)).resolves.toEqual({
      jobId: "job-id",
      requestId: input.requestId,
    });
    expect(send).toHaveBeenCalledWith(
      linearTicketQueue,
      expect.objectContaining({
        kind: "linear_ticket",
        requestId: input.requestId,
      }),
      { singletonKey: `linear-ticket:${input.requestId}` },
    );
  });

  it("fails clearly when the durable job is not created", async () => {
    await expect(
      queueLinearTicketJob({ send: vi.fn().mockResolvedValue(null) }, input),
    ).rejects.toThrow("Linear ticket job was not created");
  });

  it("loads each agent configuration once per drain", async () => {
    vi.mocked(listLinearTicketRequestsForQueue).mockResolvedValue([
      {
        agentConfigVersionId: input.config.id,
        investigationId: input.investigationId,
        requestId: input.requestId,
      },
      {
        agentConfigVersionId: input.config.id,
        investigationId: input.investigationId,
        requestId: "10000000-0000-4000-8000-000000000006",
      },
    ]);
    vi.mocked(getRuntimeAgentConfig).mockResolvedValue(input.config);
    const send = vi.fn().mockResolvedValueOnce("job-1").mockResolvedValueOnce("job-2");

    await expect(queuePendingLinearTicketJobs({ send })).resolves.toBe(2);
    expect(getRuntimeAgentConfig).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
