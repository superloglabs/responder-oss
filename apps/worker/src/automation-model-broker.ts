import type { DaytonaClientConfig } from "@responder/core/daytona-config";
import {
  createAutomationModelBrokerGrant,
  revokeAutomationModelBrokerGrant,
} from "@responder/core/db/automation-model-broker";
import {
  type AutomationHarnessResult,
} from "./automation-harness.js";
import { runInFreshAutomationSandbox } from "./automation-sandbox.js";
import { runCodexAutomation } from "./codex-automation-harness.js";

interface BrokeredAutomationProofInput {
  brokerBaseUrl: string;
  config: DaytonaClientConfig;
  maxOutputTokensPerRequest: number;
  maxRequests: number;
  maxRuntimeSeconds: number;
  leaseId: string;
  model: string;
  organizationId: string;
  prompt: string;
  providerApiKey: string;
  runId: string;
  workspacePath: string;
}

interface BrokeredAutomationProofDependencies {
  createGrant: typeof createAutomationModelBrokerGrant;
  now: () => Date;
  revokeGrant: typeof revokeAutomationModelBrokerGrant;
  runHarness: typeof runCodexAutomation;
  runInSandbox: typeof runInFreshAutomationSandbox;
}

const defaultDependencies: BrokeredAutomationProofDependencies = {
  createGrant: createAutomationModelBrokerGrant,
  now: () => new Date(),
  revokeGrant: revokeAutomationModelBrokerGrant,
  runHarness: runCodexAutomation,
  runInSandbox: runInFreshAutomationSandbox,
};

export async function runBrokeredAutomationProof(
  input: BrokeredAutomationProofInput,
  dependencies: BrokeredAutomationProofDependencies = defaultDependencies,
): Promise<AutomationHarnessResult> {
  if (
    !Number.isSafeInteger(input.maxRuntimeSeconds) ||
    input.maxRuntimeSeconds <= 0 ||
    input.maxRuntimeSeconds > 3_600
  ) {
    throw new Error("Automation proof runtime must be between 1 and 3600 seconds");
  }
  const grant = await dependencies.createGrant({
    apiKey: input.providerApiKey,
    expiresAt: new Date(
      dependencies.now().getTime() + input.maxRuntimeSeconds * 1_000,
    ),
    maxOutputTokensPerRequest: input.maxOutputTokensPerRequest,
    maxRequests: input.maxRequests,
    model: input.model,
    leaseId: input.leaseId,
    organizationId: input.organizationId,
    provider: "openai",
    runId: input.runId,
  });

  let outcome:
    | { error: unknown; succeeded: false }
    | { succeeded: true; value: AutomationHarnessResult };
  try {
    outcome = {
      succeeded: true,
      value: await dependencies.runInSandbox({
        brokerToken: grant.token,
        config: input.config,
        organizationId: input.organizationId,
        run: (session, withModelBroker) =>
          withModelBroker(() =>
            dependencies.runHarness(session, {
              contextServers: [],
              model: {
                brokerBaseUrl: input.brokerBaseUrl,
                model: input.model,
                provider: "openai",
              },
              prompt: input.prompt,
              workspacePath: input.workspacePath,
            })
          ),
        runId: input.runId,
      }),
    };
  } catch (error) {
    outcome = { error, succeeded: false };
  }

  try {
    await dependencies.revokeGrant({
      grantId: grant.id,
      organizationId: input.organizationId,
      runId: input.runId,
    });
  } catch (revokeError) {
    if (outcome.succeeded) throw revokeError;
    throw new AggregateError(
      [outcome.error, revokeError],
      "Automation proof and broker grant revocation failed",
    );
  }
  if (!outcome.succeeded) throw outcome.error;
  return outcome.value;
}
