import { afterEach, describe, expect, it, vi } from "vitest";
import {
  failCodebaseKnowledgeGeneration,
  markCodebaseKnowledgeQueued,
} from "./db/knowledge-base.js";
import { codebaseKnowledgeQueue } from "./jobs.js";
import { queueCodebaseKnowledgeTarget } from "./knowledge-base-queue.js";

vi.mock("./db/knowledge-base.js", () => ({
  failCodebaseKnowledgeGeneration: vi.fn(),
  getCodebaseKnowledgeRefreshTarget: vi.fn(),
  listCodebaseKnowledgeRefreshTargets: vi.fn(),
  markCodebaseKnowledgeQueued: vi.fn(),
}));

const target = {
  defaultBranch: "main",
  fullName: "example/repository",
  installationId: 123,
  organizationId: "15151515-1515-4515-8515-151515151515",
  private: true,
  repositoryId: "13131313-1313-4313-8313-131313131313",
};

describe("codebase knowledge queue", () => {
  afterEach(() => vi.clearAllMocks());

  it("records queued state before publishing an exclusive versioned job", async () => {
    const order: string[] = [];
    vi.mocked(markCodebaseKnowledgeQueued).mockImplementation(async () => {
      order.push("database");
    });
    const send = vi.fn().mockImplementation(async () => {
      order.push("queue");
      return "job-id";
    });

    await expect(
      queueCodebaseKnowledgeTarget({ send }, target, true),
    ).resolves.toMatchObject({ jobId: "job-id", target });
    expect(order).toEqual(["database", "queue"]);
    expect(send).toHaveBeenCalledWith(
      codebaseKnowledgeQueue,
      expect.objectContaining({
        force: true,
        organizationId: target.organizationId,
        repositoryId: target.repositoryId,
      }),
      {
        singletonKey: `codebase-knowledge-force:${target.repositoryId}`,
      },
    );
  });

  it("keeps forced refreshes separate from scheduled refreshes", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    await queueCodebaseKnowledgeTarget({ send }, target, false);
    await queueCodebaseKnowledgeTarget({ send }, target, true);

    expect(send.mock.calls.map((call) => call[2])).toEqual([
      { singletonKey: `codebase-knowledge:${target.repositoryId}` },
      { singletonKey: `codebase-knowledge-force:${target.repositoryId}` },
    ]);
  });

  it("records a safe failure when publication fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await expect(
      queueCodebaseKnowledgeTarget({ send }, target),
    ).rejects.toThrow("queue unavailable");
    expect(failCodebaseKnowledgeGeneration).toHaveBeenCalledWith({
      repositoryId: target.repositoryId,
      failureReason: "queue unavailable",
    });
  });
});
