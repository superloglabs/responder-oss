import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beginInvestigation: vi.fn(),
  bossSend: vi.fn(),
  bossStart: vi.fn(),
  bossStop: vi.fn(),
  consumeInvestigation: vi.fn(),
  discardPendingInvestigation: vi.fn(),
  failInvestigation: vi.fn(),
  failIssuePullRequest: vi.fn(),
  getIssuePullRequestForRemediation: vi.fn(),
  getRuntimeAgentConfig: vi.fn(),
  markIssuePullRequestStarted: vi.fn(),
  notifyBillingLimitReached: vi.fn(),
  prepareWorkerQueues: vi.fn(),
  setIssuePullRequestSession: vi.fn(),
}));

vi.mock("../../../../packages/core/src/billing/autumn.js", () => ({
  consumeInvestigation: mocks.consumeInvestigation,
}));

vi.mock("../../../../packages/core/src/billing/notifications.js", () => ({
  notifyBillingLimitReached: mocks.notifyBillingLimitReached,
}));

vi.mock("../../../../packages/core/src/db/investigations.js", () => ({
  beginInvestigation: mocks.beginInvestigation,
  discardPendingInvestigation: mocks.discardPendingInvestigation,
  failInvestigation: mocks.failInvestigation,
  getRuntimeAgentConfig: mocks.getRuntimeAgentConfig,
}));

vi.mock("../../../../packages/core/src/db/pull-requests.js", () => ({
  failIssuePullRequest: mocks.failIssuePullRequest,
  getIssuePullRequestForRemediation:
    mocks.getIssuePullRequestForRemediation,
  markIssuePullRequestStarted: mocks.markIssuePullRequestStarted,
  setIssuePullRequestSession: mocks.setIssuePullRequestSession,
}));

vi.mock("../../../../packages/core/src/jobs.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../../../packages/core/src/jobs.js")
  >();
  return {
    ...original,
    createJobBoss: () => ({
      on: vi.fn(),
      send: mocks.bossSend,
      start: mocks.bossStart,
      stop: mocks.bossStop,
    }),
    prepareWorkerQueues: mocks.prepareWorkerQueues,
  };
});

import {
  closeInvestigationQueue,
  queueInvestigation,
  queueIssueRemediation,
} from "./queue.js";

const request = {
  agentId: "7f83b096-1299-47d3-bd10-d617463a15d1",
  body: "The API is returning HTTP 500.",
  externalEventId: "event-1",
  provider: "sentry" as const,
  title: "Production error",
};

const created = {
  config: {
    agentId: request.agentId,
    id: "684a11c5-f5b8-4ff5-b157-592e04164dd3",
    model: "old-provider-model",
    organizationId: "9ba9e0a6-b15c-4674-bf91-18d70b6ff450",
    prMode: "disabled" as const,
    prompt: "Investigate carefully.",
  },
  created: true,
  investigationId: "9ec74cbd-b9bd-452b-932f-19bc64084203",
  runtimeProfileId: "cf72339f-a631-448f-b8af-f9d8336ad879",
};
const remediationRequest = {
  requestId: "4614c371-a4a3-4342-a9a8-36e526377345",
  issueId: "6e55b174-e903-4d76-973f-9dff4a4e9883",
  issueTitle: "Broken route",
  issueDescription: "The route throws.",
  issueSeverity: "SEV-2" as const,
  issueRemediation: "Handle the missing value.",
  issueEvidence: [],
  investigationId: created.investigationId,
  agentConfigVersionId: created.config.id,
  agentId: created.config.agentId,
  organizationId: created.config.organizationId,
  runtimeProfileId: created.runtimeProfileId,
  status: "queued" as const,
};

describe("investigation queue", () => {
  beforeEach(async () => {
    await closeInvestigationQueue();
    vi.clearAllMocks();
    mocks.beginInvestigation.mockResolvedValue(created);
    mocks.consumeInvestigation.mockResolvedValue({
      allowed: true,
      configured: false,
      nextResetAt: null,
    });
    mocks.bossStart.mockResolvedValue(undefined);
    mocks.prepareWorkerQueues.mockResolvedValue(undefined);
    mocks.notifyBillingLimitReached.mockResolvedValue(undefined);
    mocks.getIssuePullRequestForRemediation.mockResolvedValue(
      remediationRequest,
    );
    mocks.getRuntimeAgentConfig.mockResolvedValue(created.config);
    mocks.bossSend.mockResolvedValue(
      "e9c7b0b1-1f28-448f-b5a7-0cb240ae41e4",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not charge or enqueue a duplicate alert", async () => {
    mocks.beginInvestigation.mockResolvedValue({ ...created, created: false });

    await expect(queueInvestigation(request)).resolves.toEqual({
      investigationId: created.investigationId,
      kind: "duplicate",
    });
    expect(mocks.consumeInvestigation).not.toHaveBeenCalled();
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("checks the monthly limit and adds a new job", async () => {
    await expect(queueInvestigation(request)).resolves.toEqual({
      investigationId: created.investigationId,
      jobId: "e9c7b0b1-1f28-448f-b5a7-0cb240ae41e4",
      kind: "queued",
    });
    expect(mocks.consumeInvestigation).toHaveBeenCalledWith(
      created.config.organizationId,
      created.investigationId,
    );
    expect(mocks.bossSend).toHaveBeenCalledWith(
      "responder-investigations",
      expect.objectContaining({ investigationId: created.investigationId }),
      { singletonKey: created.investigationId },
    );
  });

  it("removes an unstarted investigation when the monthly limit is reached", async () => {
    mocks.consumeInvestigation.mockResolvedValue({
      allowed: false,
      configured: true,
      nextResetAt: 1_800_000_000,
    });

    await expect(queueInvestigation(request)).resolves.toEqual({
      kind: "blocked",
    });
    expect(mocks.discardPendingInvestigation).toHaveBeenCalledWith(
      created.investigationId,
    );
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("fails a remediation request when the queue cannot start", async () => {
    const error = new Error("database unavailable");
    mocks.bossStart.mockRejectedValueOnce(error);

    await expect(
      queueIssueRemediation(remediationRequest.requestId),
    ).rejects.toBe(error);
    expect(mocks.markIssuePullRequestStarted).toHaveBeenCalledWith(
      remediationRequest.requestId,
    );
    expect(mocks.failIssuePullRequest).toHaveBeenCalledWith(
      remediationRequest.requestId,
      "database unavailable",
    );
  });
});
