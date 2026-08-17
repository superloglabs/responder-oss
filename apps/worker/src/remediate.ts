import {
  MaxTurnsExceededError,
  run,
  setDefaultOpenAIKey,
  setTracingDisabled,
} from "@openai/agents";
import { Capabilities, SandboxAgent } from "@openai/agents/sandbox";
import {
  DaytonaSandboxClient,
  type DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import { getRuntimeProfile } from "@responder/core/db/runtime-profiles";
import { getRuntimeWorkspaceSecrets } from "@responder/core/db/workspace-secrets";
import { daytonaClientOptions } from "@responder/core/daytona-config";
import type { RemediationJob } from "@responder/core/jobs";
import { renderIssueFixPrompt } from "@responder/core/investigations/report";
import {
  safeInvestigationError,
  sandboxAgentConfig,
} from "./investigate.js";
import { createPullRequestTool } from "./pull-request.js";
import { checkoutRuntimeRepositories } from "./repositories.js";
import {
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  prepareDaytonaSandbox,
} from "./sandbox.js";
import {
  redactDaytonaSecretPlaceholders,
  workspaceSecretUsageInstructions,
} from "./secret-safety.js";

export const remediationMaxTurns = 40;
export const remediationApplyPatchPathInstruction =
  "When using apply_patch, use the full absolute checkout path shown above. Repository-relative paths are resolved from the workspace root and may target the wrong location.";

export interface RemediationApplyPatchFailure {
  callId: string;
  error: string;
  operation?: "create_file" | "delete_file" | "update_file";
  path?: string;
}

export interface RemediationRunDiagnostics {
  applyPatchFailures: RemediationApplyPatchFailure[];
  completedTurns: number;
  maxTurns: number | null;
}

const maxStoredApplyPatchFailures = 10;

export function remediationRunDiagnostics(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): RemediationRunDiagnostics | undefined {
  if (!(error instanceof MaxTurnsExceededError) || !error.state) {
    return undefined;
  }

  const state = error.state.toJSON();
  const operations = new Map<
    string,
    {
      operation: "create_file" | "delete_file" | "update_file";
      path: string;
    }
  >();

  for (const item of state.generatedItems) {
    if (
      item.type !== "tool_call_item" ||
      item.rawItem.type !== "apply_patch_call"
    ) {
      continue;
    }
    operations.set(item.rawItem.callId, {
      operation: item.rawItem.operation.type,
      path: item.rawItem.operation.path,
    });
  }

  const applyPatchFailures = state.generatedItems
    .flatMap((item): RemediationApplyPatchFailure[] => {
      if (
        item.type !== "tool_call_output_item" ||
        item.rawItem.type !== "apply_patch_call_output" ||
        item.rawItem.status !== "failed"
      ) {
        return [];
      }
      const operation = operations.get(item.rawItem.callId);
      const output =
        item.rawItem.output ||
        (typeof item.output === "string" ? item.output : undefined) ||
        "apply_patch failed without an error message";
      return [
        {
          callId: item.rawItem.callId,
          error: safeInvestigationError(new Error(output), environment),
          ...(operation ?? {}),
        },
      ];
    })
    .slice(-maxStoredApplyPatchFailures);

  return {
    applyPatchFailures,
    completedTurns: Math.max(0, state.currentTurn - 1),
    maxTurns: state.maxTurns,
  };
}

export async function runRemediationAgent(
  job: RemediationJob,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const config = sandboxAgentConfig(environment);
  setDefaultOpenAIKey(config.openAiApiKey);
  setTracingDisabled(true);
  const runtimeProfile = await getRuntimeProfile(job.runtimeProfileId);
  const workspaceSecrets = await getRuntimeWorkspaceSecrets(job.config.id);
  const client = new DaytonaSandboxClient({
    ...daytonaClientOptions(config),
    name: `responder-remediation-${job.remediationRequestId}`,
    pauseOnExit: false,
  });
  let session: DaytonaSandboxSession | null = null;

  try {
    session = await client.create();
    await configureDaytonaSandboxLifecycle(session, config, workspaceSecrets);
    await prepareDaytonaSandbox(session);
    const repositories = await checkoutRuntimeRepositories(
      session,
      job.config.id,
    );
    if (repositories.length === 0) {
      throw new Error("No repositories are attached to this Agent version");
    }
    const pullRequestTool = createPullRequestTool({
      agentConfigVersionId: job.config.id,
      investigationId: job.investigationId,
      organizationId: job.config.organizationId,
      pullRequestRequestId: job.remediationRequestId,
      session,
    });
    const agent = new SandboxAgent({
      name: "Responder issue fixer",
      model: config.model,
      instructions: [
        runtimeProfile?.systemPrompt,
        job.config.prompt,
        renderIssueFixPrompt(job.issue),
        "The selected repositories are already checked out:",
        ...repositories.map(
          (repository) =>
            `- ${repository.repository}: ${repository.path} (${repository.branch} at ${repository.sha})`,
        ),
        remediationApplyPatchPathInstruction,
        "Inspect the relevant code, make the smallest safe fix in exactly one selected repository, and run the narrowest useful checks.",
        `Then call create_pull_request with issue ID ${job.issue.id}. Do not finish without creating the pull request or clearly explaining why no safe code fix is possible.`,
        "Do not expose credentials or secret values. The pull request is the only allowed external change.",
        workspaceSecretUsageInstructions(workspaceSecrets),
      ]
        .filter((instruction): instruction is string => Boolean(instruction))
        .join("\n\n"),
      capabilities: Capabilities.default(),
      tools: [pullRequestTool],
    });
    const result = await run(agent, renderIssueFixPrompt(job.issue), {
      maxTurns: remediationMaxTurns,
      sandbox: { session },
    });
    if (typeof result.finalOutput !== "string" || !result.finalOutput.trim()) {
      throw new Error("OpenAI agent returned an empty remediation result");
    }
    return redactDaytonaSecretPlaceholders(result.finalOutput.trim());
  } finally {
    if (session) {
      await closeDaytonaSandbox(session, config, {
        investigationId: job.investigationId,
        organizationId: job.config.organizationId,
        requestId: job.remediationRequestId,
      });
    }
  }
}
