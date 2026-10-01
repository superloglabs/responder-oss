import { createHash } from "node:crypto";
import type { AutomationContextBrokerClaim } from "../../../../packages/core/src/db/automation-model-broker.js";
import type {
  appendAutomationRunEvent,
  beginAutomationActionAttempt,
  completeAutomationActionAttempt,
  failAutomationActionAttempt,
} from "../../../../packages/core/src/db/automations.js";
import type { AutomationActionKind } from "../../../../packages/core/src/db/schema.js";

export interface RecordedWriteDependencies {
  appendEvent: typeof appendAutomationRunEvent;
  beginAttempt: typeof beginAutomationActionAttempt;
  completeAttempt: typeof completeAutomationActionAttempt;
  failAttempt: typeof failAutomationActionAttempt;
}

// Records a broker write as an action attempt. A repeated call with the same
// identity in one run returns the earlier result instead of writing again. A
// failed attempt is retried under the same attempt ID.
export async function recordedWrite(input: {
  claim: AutomationContextBrokerClaim;
  dependencies: RecordedWriteDependencies;
  eventData?: Record<string, unknown>;
  identity: unknown;
  kind: AutomationActionKind;
  redactedInput: Record<string, unknown>;
  toolName: string;
  write: (attemptId: string) => Promise<string>;
}): Promise<{ externalReference: string | null; repeated: boolean }> {
  const idempotencyKey = createHash("sha256")
    .update(`${input.claim.runId}\0${input.kind}\0${JSON.stringify(input.identity)}`, "utf8")
    .digest("hex");
  const attempt = await input.dependencies.beginAttempt({
    idempotencyKey,
    kind: input.kind,
    redactedInput: input.redactedInput,
    retryFailed: true,
    runId: input.claim.runId,
    toolCallId: input.toolName,
  });
  if (attempt.status === "existing_succeeded") {
    return { externalReference: attempt.externalReference, repeated: true };
  }
  let externalReference: string;
  try {
    externalReference = await input.write(attempt.id);
  } catch (error) {
    await input.dependencies.failAttempt({
      attemptId: attempt.id,
      failureMessage: error instanceof Error ? error.message.slice(0, 2_000) : "Action failed",
    });
    throw error;
  }
  await input.dependencies.completeAttempt({ attemptId: attempt.id, externalReference });
  await input.dependencies.appendEvent({
    data: { ...input.eventData, externalReference, kind: input.kind },
    runId: input.claim.runId,
    type: "action_succeeded",
  }).catch(() => undefined);
  return { externalReference, repeated: false };
}
