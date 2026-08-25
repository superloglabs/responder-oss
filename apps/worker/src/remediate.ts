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
export const remediationFailureMechanismInstruction =
  "For the pull request failure mechanism, explain what failed and why in one or two very short sentences. Use extremely simple language that anyone can understand at a glance. Use no jargon, acronyms, code names, or implementation details.";

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

function safeApplyPatchFailure(
  output: string | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  if (!output?.trim()) {
    return "apply_patch failed without an error message";
  }
  const safeOutput = safeInvestigationError(new Error(output), environment);
  const invalidEofContext = safeOutput.match(
    /^Invalid EOF Context(?:\s+(\d+))?(?::|$)/,
  );
  if (invalidEofContext) {
    return `Invalid EOF Context${invalidEofContext[1] ? ` ${invalidEofContext[1]}` : ""}`;
  }

  const invalidContext = safeOutput.match(
    /^Invalid Context(?:\s+(\d+))?(?::|$)/,
  );
  if (invalidContext) {
    return `Invalid Context${invalidContext[1] ? ` ${invalidContext[1]}` : ""}`;
  }

  if (/^Invalid Add File Line:/.test(safeOutput)) {
    return "Invalid add-file patch line";
  }
  if (/^Invalid Line:/.test(safeOutput)) {
    return "Invalid patch line";
  }
  if (/^Cannot create file because it already exists:/.test(safeOutput)) {
    return "File already exists";
  }
  if (/^Nothing in this section/.test(safeOutput)) {
    return "Patch section did not match";
  }
  if (/^applyDiff: chunk\.origIndex/.test(safeOutput)) {
    return "Invalid patch chunk position";
  }
  if (/overlapping (?:patch )?chunks/i.test(safeOutput)) {
    return "Overlapping patch chunks";
  }
  if (/not a regular file/i.test(safeOutput)) {
    return "Patch target is not a regular file";
  }
  if (/workspace escape/i.test(safeOutput)) {
    return "Patch target is outside the workspace";
  }
  if (/directory target/i.test(safeOutput)) {
    return "Patch target is a directory";
  }
  if (/remote editor operation failed/i.test(safeOutput)) {
    return "Remote editor operation failed";
  }
  return "Unclassified apply_patch failure";
}

export function remediationRunDiagnostics(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): RemediationRunDiagnostics | undefined {
  if (!(error instanceof MaxTurnsExceededError) || !error.state) {
    return undefined;
  }

  try {
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
          (typeof item.output === "string" ? item.output : undefined);
        return [
          {
            callId: item.rawItem.callId,
            error: safeApplyPatchFailure(output, environment),
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
  } catch {
    return undefined;
  }
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
        renderIssueFixPrompt(job.issue, job.selectedRemediation),
        "The selected repositories are already checked out:",
        ...repositories.map(
          (repository) =>
            `- ${repository.repository}: ${repository.path} (${repository.branch} at ${repository.sha})`,
        ),
        remediationApplyPatchPathInstruction,
        job.selectedRemediation?.type === "code_change"
          ? "Use the proposed diff as the starting point. Verify it against the current checkout, adjust it when needed, make the smallest safe fix in exactly one selected repository, and run the narrowest useful checks."
          : "Inspect the relevant code, make the smallest safe fix in exactly one selected repository, and run the narrowest useful checks.",
        remediationFailureMechanismInstruction,
        `Then call create_pull_request with issue ID ${job.issue.id}. Do not finish without creating the pull request or clearly explaining why no safe code fix is possible.`,
        "Do not expose credentials or secret values. The pull request is the only allowed external change.",
        workspaceSecretUsageInstructions(workspaceSecrets),
      ]
        .filter((instruction): instruction is string => Boolean(instruction))
        .join("\n\n"),
      capabilities: Capabilities.default(),
      tools: [pullRequestTool],
    });
    const result = await run(
      agent,
      renderIssueFixPrompt(job.issue, job.selectedRemediation),
      {
        maxTurns: remediationMaxTurns,
        sandbox: { session },
      },
    );
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
