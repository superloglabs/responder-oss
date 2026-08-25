import {
  completeInvestigation,
  completeInvestigationReplay,
} from "@responder/core/db/investigations";
import { deliverCompletedInvestigationWithWarnings } from "./report.js";

interface InvestigationCompletionDependencies {
  complete: typeof completeInvestigation;
  completeReplay: typeof completeInvestigationReplay;
  deliver: typeof deliverCompletedInvestigationWithWarnings;
}

const defaultDependencies: InvestigationCompletionDependencies = {
  complete: completeInvestigation,
  completeReplay: completeInvestigationReplay,
  deliver: deliverCompletedInvestigationWithWarnings,
};

export async function completeInvestigationRun(
  input: {
    deliveryRunId: string;
    investigationId: string;
    replay: boolean;
    report: string;
  },
  dependencies: InvestigationCompletionDependencies = defaultDependencies,
): Promise<string[]> {
  if (input.replay) {
    try {
      await dependencies.completeReplay(input.investigationId, input.report);
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          event: "investigation_replay_completion_failed",
          investigationId: input.investigationId,
        }),
      );
      throw error;
    }
    return [];
  }
  try {
    await dependencies.complete(input.investigationId, input.report);
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "investigation_completion_failed",
        investigationId: input.investigationId,
      }),
    );
    throw error;
  }
  return dependencies.deliver(input.investigationId, input.deliveryRunId);
}

export async function deliverPersistedInvestigationAfterFailure(
  input: {
    deliveryRunId: string;
    investigationFailed: boolean;
    investigationId: string;
    replay: boolean;
  },
  deliver: typeof deliverCompletedInvestigationWithWarnings =
    deliverCompletedInvestigationWithWarnings,
): Promise<string[]> {
  if (input.replay || input.investigationFailed) return [];
  return deliver(input.investigationId, input.deliveryRunId);
}
