import {
  claimInvestigationReplayRequest,
  completeInvestigationReplayRequest,
  failInvestigation,
  failInvestigationReplayRequest,
  InvestigationRetryError,
  markInvestigationReplayRequestQueued,
  prepareInvestigationReplayRequest,
  releaseInvestigationReplayRequest,
} from "@responder/core/db/investigations";
import { investigationQueue } from "@responder/core/jobs";

export interface ReplayRequestJobQueue {
  send(
    name: string,
    data: Record<string, unknown>,
    options: { singletonKey: string },
  ): Promise<string | null>;
}

export class InvestigationReplayRequestProcessingError extends Error {
  constructor(
    message: string,
    readonly investigationId: string,
    readonly sourceInvestigationId: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "InvestigationReplayRequestProcessingError";
  }
}

export async function processNextInvestigationReplayRequest(
  queue: ReplayRequestJobQueue,
): Promise<boolean> {
  const request = await claimInvestigationReplayRequest();
  if (!request) return false;
  if ("exhausted" in request) return true;

  try {
    try {
      const replay = await prepareInvestigationReplayRequest(request);
      if (replay.replayStatus === "resolved") {
        await completeInvestigationReplayRequest(replay.investigationId);
        return true;
      }
      if (replay.replayStatus === "failed") {
        await failInvestigationReplayRequest(
          replay.investigationId,
          "Replay investigation has already failed",
        );
        return true;
      }

      const jobId = await queue.send(
        investigationQueue,
        {
          kind: "investigation",
          config: replay.config,
          investigationId: replay.investigationId,
          queuedAt: new Date().toISOString(),
          replay: true,
          request: {
            agentId: replay.config.agentId,
            body: replay.input.body,
            externalEventId: replay.input.externalEventId,
            provider: replay.input.provider,
            title: replay.input.title,
            ...(replay.input.sourceUrl
              ? { sourceUrl: replay.input.sourceUrl }
              : {}),
            ...(replay.input.attributes
              ? { attributes: replay.input.attributes }
              : {}),
          },
          runtimeProfileId: replay.runtimeProfileId,
        },
        { singletonKey: `replay:${replay.investigationId}` },
      );
      if (!jobId && replay.created) {
        throw new Error("The replay job was not created");
      }
      await markInvestigationReplayRequestQueued(request.id);
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to queue replay request";
      if (error instanceof InvestigationRetryError) {
        console.error(
          JSON.stringify({
            error: message,
            event: "investigation_replay_request_permanently_failed",
            investigationId: request.replayInvestigationId,
          }),
        );
        await failInvestigationReplayRequest(
          request.replayInvestigationId,
          message,
        );
        await failInvestigation(request.replayInvestigationId, message);
        return true;
      }
      const released = await releaseInvestigationReplayRequest(
        request,
        message,
      );
      if (released.failed) {
        await failInvestigation(request.replayInvestigationId, message);
      }
      throw error;
    }
  } catch (error) {
    throw new InvestigationReplayRequestProcessingError(
      error instanceof Error
        ? error.message
        : "Unable to queue replay request",
      request.replayInvestigationId,
      request.sourceInvestigationId,
      error,
    );
  }
}
