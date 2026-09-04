import { describe, expect, it, vi } from "vitest";
import {
  codebaseKnowledgeJobSchema,
  codebaseKnowledgeQueue,
  createJobBoss,
  investigationJobSchema,
  investigationLocalConcurrency,
  investigationQueue,
  linearTicketQueue,
  migrateLegacyInvestigationHeartbeats,
  prepareWorkerQueues,
  pullRequestReviewJobSchema,
  pullRequestReviewQueue,
  remediationQueue,
  remediationJobSchema,
  workerHealthJobSchema,
  workerHealthQueue,
} from "./jobs.js";

describe("background jobs", () => {
  it("allows two investigations to run concurrently on each worker", () => {
    expect(investigationLocalConcurrency).toBe(2);
  });

  it("migrates queued legacy investigations without reclassifying active work", async () => {
    const executeSql = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "job-id" }] });

    await migrateLegacyInvestigationHeartbeats({
      getDb: () => ({ executeSql }),
    } as never, {
      handoffWaitMs: 0,
      now: () => 0,
    });

    expect(executeSql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("state IN ('created', 'retry')"),
      [investigationQueue, 60],
    );
    expect(executeSql).toHaveBeenCalledTimes(2);
    expect(executeSql.mock.calls.flat().join("\n")).not.toContain(
      "heartbeat_on = now()",
    );
  });

  it("waits for the old worker to hand active legacy work back", async () => {
    const executeSql = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "job-id" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const wait = vi.fn().mockResolvedValue(undefined);

    await migrateLegacyInvestigationHeartbeats({
      getDb: () => ({ executeSql }),
    } as never, {
      handoffWaitMs: 1,
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0),
      wait,
    });

    expect(wait).toHaveBeenCalledWith(1_000);
    expect(executeSql).toHaveBeenCalledTimes(4);
  });

  it("uses a stable worker health queue name", () => {
    expect(workerHealthQueue).toBe("responder-worker-health");
    expect(investigationQueue).toBe("responder-investigations");
  });

  it("enforces Linear request singleton keys at the queue policy boundary", async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined);
    const executeSql = vi.fn().mockResolvedValue({ rows: [] });
    const updateQueue = vi.fn().mockResolvedValue(undefined);

    await prepareWorkerQueues({
      createQueue,
      getDb: () => ({ executeSql }),
      updateQueue,
    } as never);

    expect(linearTicketQueue).toBe("responder-linear-tickets-v2");
    expect(createQueue).toHaveBeenCalledWith(
      linearTicketQueue,
      expect.objectContaining({ policy: "exclusive" }),
    );
  });

  it("uses an exclusive queue for daily codebase knowledge refreshes", async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined);
    const executeSql = vi.fn().mockResolvedValue({ rows: [] });
    const updateQueue = vi.fn().mockResolvedValue(undefined);

    await prepareWorkerQueues({
      createQueue,
      getDb: () => ({ executeSql }),
      updateQueue,
    } as never);

    expect(createQueue).toHaveBeenCalledWith(
      codebaseKnowledgeQueue,
      expect.objectContaining({
        expireInSeconds: 7_200,
        policy: "exclusive",
        retryLimit: 2,
      }),
    );
    const parsedJob = codebaseKnowledgeJobSchema.parse({
      kind: "codebase_knowledge_refresh",
      organizationId: "15151515-1515-4515-8515-151515151515",
      repositoryId: "13131313-1313-4313-8313-131313131313",
      requestedAt: "2026-09-04T03:00:00.000Z",
    });
    expect(parsedJob.kind).toBe("codebase_knowledge_refresh");
    if (parsedJob.kind !== "codebase_knowledge_refresh") {
      throw new Error("Expected a refresh job");
    }
    expect(parsedJob.force).toBe(false);
  });

  it("detects interrupted investigations without shortening their runtime limit", async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined);
    const executeSql = vi.fn().mockResolvedValue({ rows: [] });
    const updateQueue = vi.fn().mockResolvedValue(undefined);

    await prepareWorkerQueues({
      createQueue,
      getDb: () => ({ executeSql }),
      updateQueue,
    } as never);

    expect(createQueue).toHaveBeenCalledWith(
      investigationQueue,
      expect.objectContaining({
        expireInSeconds: 3_600,
        heartbeatSeconds: 60,
        retryLimit: 2,
      }),
    );
    expect(updateQueue).toHaveBeenCalledWith(investigationQueue, {
      heartbeatSeconds: 60,
    });
  });

  it("uses a versioned exclusive queue for remediation side effects", async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined);
    const executeSql = vi.fn().mockResolvedValue({ rows: [] });
    const updateQueue = vi.fn().mockResolvedValue(undefined);

    await prepareWorkerQueues({
      createQueue,
      getDb: () => ({ executeSql }),
      updateQueue,
    } as never);

    expect(remediationQueue).toBe("responder-remediations-v2");
    expect(createQueue).toHaveBeenCalledWith(
      remediationQueue,
      expect.objectContaining({ policy: "exclusive", retryLimit: 0 }),
    );
    expect(createQueue).not.toHaveBeenCalledWith(
      remediationQueue,
      expect.objectContaining({ retryBackoff: true }),
    );
  });

  it("serializes pull request review side effects without dropping later events", async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined);
    const executeSql = vi.fn().mockResolvedValue({ rows: [] });
    const updateQueue = vi.fn().mockResolvedValue(undefined);

    await prepareWorkerQueues({
      createQueue,
      getDb: () => ({ executeSql }),
      updateQueue,
    } as never);

    expect(pullRequestReviewQueue).toBe("responder-pull-request-reviews-v1");
    expect(createQueue).toHaveBeenCalledWith(
      pullRequestReviewQueue,
      expect.objectContaining({
        policy: "key_strict_fifo",
        retryBackoff: true,
        retryLimit: 3,
      }),
    );
  });

  it("accepts an investigation job", () => {
    expect(
      investigationJobSchema.parse({
        kind: "investigation",
        config: {
          agentId: "13131313-1313-4313-8313-131313131313",
          id: "08080808-0808-4808-8808-080808080808",
          model: "instance/default",
          organizationId: "15151515-1515-4515-8515-151515151515",
          prMode: "manual",
          prompt: "Investigate carefully.",
        },
        investigationId: "16161616-1616-4616-8616-161616161616",
        queuedAt: "2026-08-05T08:00:00.000Z",
        request: {
          agentId: "13131313-1313-4313-8313-131313131313",
          body: "The API is returning HTTP 500.",
          externalEventId: "event-1",
          provider: "sentry",
          title: "Production error",
        },
        runtimeProfileId: "19191919-1919-4919-8919-191919191919",
      }).investigationId,
    ).toBe("16161616-1616-4616-8616-161616161616");
  });

  it("accepts a no-issue Slack follow-up job", () => {
    const job = investigationJobSchema.parse({
      kind: "investigation",
      config: {
        agentId: "13131313-1313-4313-8313-131313131313",
        id: "08080808-0808-4808-8808-080808080808",
        model: "instance/default",
        organizationId: "15151515-1515-4515-8515-151515151515",
        prMode: "manual",
        prompt: "Investigate carefully.",
      },
      investigationId: "16161616-1616-4616-8616-161616161616",
      queuedAt: "2026-09-02T08:00:00.000Z",
      request: {
        agentId: "13131313-1313-4313-8313-131313131313",
        body: "Reconsider the no-issue conclusion.",
        externalEventId: "event-2",
        provider: "slack",
        title: "Follow-up",
      },
      runtimeProfileId: "19191919-1919-4919-8919-191919191919",
      slackIssueFollowup: {
        channelId: "C123",
        issueIds: [],
        originalInvestigationId: "17171717-1717-4717-8717-171717171717",
        threadTimestamp: "1788350000.000100",
      },
    });

    expect(job.slackIssueFollowup?.issueIds).toEqual([]);
  });

  it("accepts a remediation job", () => {
    expect(
      remediationJobSchema.parse({
        kind: "remediation",
        config: {
          agentId: "13131313-1313-4313-8313-131313131313",
          id: "08080808-0808-4808-8808-080808080808",
          model: "instance/default",
          organizationId: "15151515-1515-4515-8515-151515151515",
          prMode: "manual",
          prompt: "Investigate carefully.",
        },
        investigationId: "16161616-1616-4616-8616-161616161616",
        issue: {
          id: "10101010-1010-4010-8010-101010101010",
          title: "Broken route",
          description: "The route throws.",
          severity: "SEV-2",
          remediation: "Handle the missing value.",
          evidence: [],
        },
        queuedAt: "2026-08-05T08:00:00.000Z",
        remediationRequestId: "05050505-0505-4505-8505-050505050505",
        runtimeProfileId: "19191919-1919-4919-8919-191919191919",
      }).kind,
    ).toBe("remediation");
  });

  it("accepts a pull request review job", () => {
    expect(
      pullRequestReviewJobSchema.parse({
        kind: "pull_request_review",
        config: {
          agentId: "13131313-1313-4313-8313-131313131313",
          id: "08080808-0808-4808-8808-080808080808",
          model: "instance/default",
          organizationId: "15151515-1515-4515-8515-151515151515",
          prMode: "manual",
          prompt: "Fix carefully.",
        },
        installationId: 123,
        investigationId: "16161616-1616-4616-8616-161616161616",
        issue: {
          id: "10101010-1010-4010-8010-101010101010",
          title: "Broken route",
          description: "The route throws.",
          severity: "SEV-2",
          remediation: "Handle the missing value.",
          evidence: [],
        },
        pullRequest: {
          branch: "fix/broken-route",
          number: 42,
          repository: "acme/app",
        },
        queuedAt: "2026-08-25T08:00:00.000Z",
        requestId: "05050505-0505-4505-8505-050505050505",
        runtimeProfileId: "19191919-1919-4919-8919-191919191919",
      }).kind,
    ).toBe("pull_request_review");
  });

  it("accepts a valid health job", () => {
    expect(
      workerHealthJobSchema.parse({
        marker: "test-123",
        requestedAt: "2026-08-05T08:00:00.000Z",
      }),
    ).toEqual({
      marker: "test-123",
      requestedAt: "2026-08-05T08:00:00.000Z",
    });
  });

  it("rejects an incomplete health job", () => {
    expect(() => workerHealthJobSchema.parse({ marker: "" })).toThrow();
  });

  it("requires database configuration", () => {
    expect(() => createJobBoss({})).toThrow(
      "Database configuration is required for background jobs",
    );
  });
});
