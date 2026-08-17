import { describe, expect, it, vi } from "vitest";
import { linearTicketQueue } from "./jobs.js";
import { queueLinearTicketJob } from "./linear-ticket-queue.js";

const input = {
  config: {
    agentId: "10000000-0000-4000-8000-000000000001",
    id: "10000000-0000-4000-8000-000000000002",
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
});
