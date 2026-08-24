import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beginInvestigation: vi.fn(),
  bossSend: vi.fn(),
  bossStart: vi.fn(),
  bossStop: vi.fn(),
  captureAnalyticsEvent: vi.fn(),
  claimIssuePullRequestForRemediation: vi.fn(),
  consumeInvestigation: vi.fn(),
  discardPendingInvestigation: vi.fn(),
  failInvestigation: vi.fn(),
  failIssuePullRequest: vi.fn(),
  finalizeInvestigationReservation: vi.fn(),
  getIssuePullRequestForRemediation: vi.fn(),
  getRuntimeAgentConfig: vi.fn(),
  notifyBillingLimitReached: vi.fn(),
  prepareInvestigationRetry: vi.fn(),
  prepareWorkerQueues: vi.fn(),
  reserveInvestigation: vi.fn(),
  setIssuePullRequestSession: vi.fn(),
}));

vi.mock("../../../../packages/core/src/analytics.js", () => ({
  captureAnalyticsEvent: mocks.captureAnalyticsEvent,
}));

vi.mock("../../../../packages/core/src/billing/autumn.js", () => ({
  consumeInvestigation: mocks.consumeInvestigation,
  finalizeInvestigationReservation: mocks.finalizeInvestigationReservation,
  reserveInvestigation: mocks.reserveInvestigation,
}));

vi.mock("../../../../packages/core/src/billing/notifications.js", () => ({
  notifyBillingLimitReached: mocks.notifyBillingLimitReached,
}));

vi.mock("../../../../packages/core/src/db/investigations.js", () => ({
  beginInvestigation: mocks.beginInvestigation,
  discardPendingInvestigation: mocks.discardPendingInvestigation,
  failInvestigation: mocks.failInvestigation,
  getRuntimeAgentConfig: mocks.getRuntimeAgentConfig,
  prepareInvestigationRetry: mocks.prepareInvestigationRetry,
}));

vi.mock("../../../../packages/core/src/db/pull-requests.js", () => ({
  claimIssuePullRequestForRemediation:
    mocks.claimIssuePullRequestForRemediation,
  failIssuePullRequest: mocks.failIssuePullRequest,
  getIssuePullRequestForRemediation:
    mocks.getIssuePullRequestForRemediation,
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
  queueInvestigationRetry,
  queueIssueRemediation,
} from "./queue.js";

const request = {
  agentId: "13131313-1313-4313-8313-131313131313",
  body: "The API is returning HTTP 500.",
  externalEventId: "event-1",
  provider: "sentry" as const,
  title: "Production error",
};

const created = {
  config: {
    agentId: request.agentId,
    id: "08080808-0808-4808-8808-080808080808",
    model: "old-provider-model",
    organizationId: "15151515-1515-4515-8515-151515151515",
    prMode: "disabled" as const,
    prompt: "Investigate carefully.",
  },
  created: true,
  investigationId: "16161616-1616-4616-8616-161616161616",
  runtimeProfileId: "19191919-1919-4919-8919-191919191919",
};
const remediationRequest = {
  requestId: "05050505-0505-4505-8505-050505050505",
  issueId: "10101010-1010-4010-8010-101010101010",
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
    mocks.reserveInvestigation.mockResolvedValue({
      allowed: true,
      configured: true,
      nextResetAt: null,
      reservationId: "rerun-reservation-1",
    });
    mocks.bossStart.mockResolvedValue(undefined);
    mocks.captureAnalyticsEvent.mockResolvedValue(undefined);
    mocks.prepareWorkerQueues.mockResolvedValue(undefined);
    mocks.notifyBillingLimitReached.mockResolvedValue(undefined);
    mocks.finalizeInvestigationReservation.mockResolvedValue(undefined);
    mocks.prepareInvestigationRetry.mockResolvedValue({
      config: created.config,
      input: request,
      investigationId: created.investigationId,
      runtimeProfileId: created.runtimeProfileId,
    });
    mocks.getIssuePullRequestForRemediation.mockResolvedValue(
      remediationRequest,
    );
    mocks.getRuntimeAgentConfig.mockResolvedValue(created.config);
    mocks.bossSend.mockResolvedValue(
      "21212121-2121-4121-8121-212121212121",
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
    expect(mocks.captureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("checks the monthly limit and adds a new job", async () => {
    await expect(queueInvestigation(request)).resolves.toEqual({
      investigationId: created.investigationId,
      jobId: "21212121-2121-4121-8121-212121212121",
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
    expect(mocks.captureAnalyticsEvent).toHaveBeenCalledWith({
      distinctId: `investigation:${created.investigationId}`,
      event: "investigation created",
      organizationId: created.config.organizationId,
      properties: {
        $process_person_profile: false,
        agent_config_version_id: created.config.id,
        agent_id: created.config.agentId,
        investigation_id: created.investigationId,
        is_replay: false,
        provider: request.provider,
      },
    });
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
    expect(mocks.captureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("charges and enqueues a rerun with its refreshed configuration", async () => {
    await expect(
      queueInvestigationRetry({
        investigationId: created.investigationId,
        organizationId: created.config.organizationId,
      }),
    ).resolves.toEqual({
      investigationId: created.investigationId,
      jobId: "21212121-2121-4121-8121-212121212121",
      kind: "queued",
    });

    expect(mocks.reserveInvestigation).toHaveBeenCalledWith(
      created.config.organizationId,
      created.investigationId,
    );
    expect(mocks.prepareInvestigationRetry).toHaveBeenCalledWith(
      created.investigationId,
    );
    expect(mocks.finalizeInvestigationReservation).toHaveBeenCalledWith(
      "rerun-reservation-1",
      "confirm",
    );
    expect(
      mocks.finalizeInvestigationReservation.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.bossSend.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.bossSend).toHaveBeenCalledWith(
      "responder-investigations",
      expect.objectContaining({ config: created.config }),
      expect.any(Object),
    );
    expect(mocks.captureAnalyticsEvent).toHaveBeenCalledWith({
      distinctId: `investigation:${created.investigationId}`,
      event: "investigation rerun",
      organizationId: created.config.organizationId,
      properties: {
        $process_person_profile: false,
        agent_config_version_id: created.config.id,
        agent_id: created.config.agentId,
        investigation_id: created.investigationId,
        provider: request.provider,
      },
    });
  });

  it("leaves a finished investigation untouched when rerun billing is blocked", async () => {
    mocks.reserveInvestigation.mockResolvedValue({
      allowed: false,
      configured: true,
      nextResetAt: 1_800_000_000,
      reservationId: null,
    });

    await expect(
      queueInvestigationRetry({
        investigationId: created.investigationId,
        organizationId: created.config.organizationId,
      }),
    ).resolves.toEqual({ kind: "blocked" });

    expect(mocks.notifyBillingLimitReached).toHaveBeenCalledWith(
      created.config.organizationId,
      1_800_000_000,
    );
    expect(mocks.prepareInvestigationRetry).not.toHaveBeenCalled();
    expect(mocks.bossSend).not.toHaveBeenCalled();
    expect(mocks.captureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("releases a reserved rerun that loses the terminal-state claim", async () => {
    const error = new Error("Only finished investigations can be retried");
    mocks.prepareInvestigationRetry.mockRejectedValue(error);

    await expect(
      queueInvestigationRetry({
        investigationId: created.investigationId,
        organizationId: created.config.organizationId,
      }),
    ).rejects.toBe(error);

    expect(mocks.finalizeInvestigationReservation).toHaveBeenCalledWith(
      "rerun-reservation-1",
      "release",
    );
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("does not enqueue a rerun when its billing reservation cannot be confirmed", async () => {
    mocks.finalizeInvestigationReservation.mockRejectedValueOnce(
      new Error("billing unavailable"),
    );

    await expect(
      queueInvestigationRetry({
        investigationId: created.investigationId,
        organizationId: created.config.organizationId,
      }),
    ).rejects.toThrow("Billing service unavailable");

    expect(mocks.failInvestigation).toHaveBeenCalledWith(
      created.investigationId,
      "Unable to confirm investigation rerun billing",
    );
    expect(mocks.finalizeInvestigationReservation).toHaveBeenNthCalledWith(
      2,
      "rerun-reservation-1",
      "release",
    );
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("fails a remediation request when the queue cannot start", async () => {
    const error = new Error("database unavailable");
    mocks.bossStart.mockRejectedValueOnce(error);

    await expect(
      queueIssueRemediation(remediationRequest.requestId),
    ).rejects.toBe(error);
    expect(mocks.claimIssuePullRequestForRemediation).toHaveBeenCalledWith(
      remediationRequest.requestId,
    );
    expect(mocks.failIssuePullRequest).toHaveBeenCalledWith(
      remediationRequest.requestId,
      "database unavailable",
    );
  });
});
