import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvestigationRetryError } from "@responder/core/db/investigations";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  failInvestigation: vi.fn(),
  failRequest: vi.fn(),
  markQueued: vi.fn(),
  prepare: vi.fn(),
  release: vi.fn(),
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
  id: "9ec74cbd-b9bd-452b-932f-19bc64084203",
  replayInvestigationId: "6dfc241e-e0d2-4a53-a9e4-eed12f994815",
  requestedBy: "admin@example.com",
  sourceInvestigationId: "b550694a-b433-4cb6-9466-80d1fcf341e9",
};

const replay = {
  config: {
    agentId: "7f83b096-1299-47d3-bd10-d617463a15d1",
    id: "684a11c5-f5b8-4ff5-b157-592e04164dd3",
    model: "provider-model",
    organizationId: "dc0542d9-b577-45f2-9f46-6ff0db354c8b",
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
  runtimeProfileId: "cf72339f-a631-448f-b8af-f9d8336ad879",
};

describe("admin replay request processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
