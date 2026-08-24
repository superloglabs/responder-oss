import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvestigationRetryError } from "@responder/core/db/investigations";

const mocks = vi.hoisted(() => ({
  captureAnalyticsEvent: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  failInvestigation: vi.fn(),
  failRequest: vi.fn(),
  markQueued: vi.fn(),
  prepare: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@responder/core/analytics", () => ({
  captureAnalyticsEvent: mocks.captureAnalyticsEvent,
}));

vi.mock("@responder/core/db/investigations", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@responder/core/db/investigations")
  >();
  return {
    ...original,
    claimInvestigationReplayRequest: mocks.claim,
    completeInvestigationReplayRequest: mocks.complete,
    failInvestigation: mocks.failInvestigation,
    failInvestigationReplayRequest: mocks.failRequest,
    markInvestigationReplayRequestQueued: mocks.markQueued,
    prepareInvestigationReplayRequest: mocks.prepare,
    releaseInvestigationReplayRequest: mocks.release,
  };
});

import {
  InvestigationReplayRequestProcessingError,
  processNextInvestigationReplayRequest,
} from "./replay-requests.js";

const request = {
  attemptCount: 1,
  id: "16161616-1616-4616-8616-161616161616",
  replayInvestigationId: "09090909-0909-4909-8909-090909090909",
  requestedBy: "admin@example.com",
  sourceInvestigationId: "18181818-1818-4818-8818-181818181818",
};

const replay = {
  config: {
    agentId: "13131313-1313-4313-8313-131313131313",
    id: "08080808-0808-4808-8808-080808080808",
    model: "provider-model",
    organizationId: "20202020-2020-4020-8020-202020202020",
    prMode: "always",
    prompt: "Investigate carefully.",
  },
  created: true,
  input: {
    body: "Production failure",
    externalEventId: "event-1",
    provider: "sentry",
    title: "Production error",
  },
  investigationId: request.replayInvestigationId,
  replayStatus: "pending",
  runtimeProfileId: "19191919-1919-4919-8919-191919191919",
};

describe("admin replay request processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureAnalyticsEvent.mockResolvedValue(undefined);
    mocks.claim.mockResolvedValue(request);
    mocks.prepare.mockResolvedValue(replay);
    mocks.release.mockResolvedValue({ failed: false });
  });

  it("turns a minimal request into a trusted replay job", async () => {
    const queue = { send: vi.fn().mockResolvedValue("job-id") };

    await expect(
      processNextInvestigationReplayRequest(queue),
    ).resolves.toBe(true);

    expect(queue.send).toHaveBeenCalledWith(
      "responder-investigations",
      expect.objectContaining({
        config: expect.objectContaining({ prMode: "always" }),
        investigationId: request.replayInvestigationId,
        replay: true,
      }),
      { singletonKey: `replay:${request.replayInvestigationId}` },
    );
    expect(mocks.markQueued).toHaveBeenCalledWith(request.id);
    expect(mocks.captureAnalyticsEvent).toHaveBeenCalledWith({
      distinctId: `investigation:${request.replayInvestigationId}`,
      event: "investigation created",
      organizationId: replay.config.organizationId,
      properties: {
        $process_person_profile: false,
        agent_config_version_id: replay.config.id,
        agent_id: replay.config.agentId,
        investigation_id: request.replayInvestigationId,
        is_replay: true,
        provider: replay.input.provider,
        source_investigation_id: request.sourceInvestigationId,
      },
    });
  });

  it("does nothing when the inbox is empty", async () => {
    mocks.claim.mockResolvedValue(null);
    const queue = { send: vi.fn() };

    await expect(
      processNextInvestigationReplayRequest(queue),
    ).resolves.toBe(false);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("continues draining after an abandoned final attempt is failed", async () => {
    mocks.claim.mockResolvedValue({ exhausted: true });
    const queue = { send: vi.fn() };

    await expect(
      processNextInvestigationReplayRequest(queue),
    ).resolves.toBe(true);
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("logs permanent replay request failures with the investigation ID", async () => {
    mocks.prepare.mockRejectedValue(
      new InvestigationRetryError("not_found", "Investigation not found"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processNextInvestigationReplayRequest({ send: vi.fn() }),
    ).resolves.toBe(true);

    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        error: "Investigation not found",
        event: "investigation_replay_request_permanently_failed",
        investigationId: request.replayInvestigationId,
      }),
    );
    expect(mocks.failRequest).toHaveBeenCalledWith(
      request.replayInvestigationId,
      "Investigation not found",
    );
    expect(mocks.failInvestigation).toHaveBeenCalledWith(
      request.replayInvestigationId,
      "Investigation not found",
    );
  });

  it("returns transient failures to the inbox", async () => {
    const error = new Error("queue unavailable");
    const queue = { send: vi.fn().mockRejectedValue(error) };

    const result = processNextInvestigationReplayRequest(queue);
    await expect(result).rejects.toMatchObject({
      investigationId: request.replayInvestigationId,
      message: "queue unavailable",
      sourceInvestigationId: request.sourceInvestigationId,
    });
    await expect(result).rejects.toBeInstanceOf(
      InvestigationReplayRequestProcessingError,
    );
    expect(mocks.release).toHaveBeenCalledWith(request, "queue unavailable");
    expect(mocks.markQueued).not.toHaveBeenCalled();
  });

  it("keeps request context when returning the request to the inbox fails", async () => {
    const queue = {
      send: vi.fn().mockRejectedValue(new Error("queue unavailable")),
    };
    mocks.release.mockRejectedValue(new Error("database unavailable"));

    await expect(
      processNextInvestigationReplayRequest(queue),
    ).rejects.toMatchObject({
      investigationId: request.replayInvestigationId,
      message: "database unavailable",
      sourceInvestigationId: request.sourceInvestigationId,
    });
  });

  it("accepts an existing singleton job after recovering a request", async () => {
    mocks.prepare.mockResolvedValue({ ...replay, created: false });
    const queue = { send: vi.fn().mockResolvedValue(null) };

    await expect(
      processNextInvestigationReplayRequest(queue),
    ).resolves.toBe(true);
    expect(mocks.markQueued).toHaveBeenCalledWith(request.id);
    expect(mocks.captureAnalyticsEvent).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
