import { createHash } from "node:crypto";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  beginAutomationActionAttempt,
  completeAutomationActionAttempt,
  failAutomationActionAttempt,
  getAutomationRuntimeRepositories,
} from "@responder/core/db/automations";
import { z } from "zod";
import { automationWorkspaceRoot } from "./automation-harness.js";
import { createPullRequestFromSandbox } from "./github-pull-request.js";
import type { CheckedOutRepository } from "./repositories.js";

export const automationActionsPath = `${automationWorkspaceRoot}/.responder/actions.json`;

// Slack writes are live MCP tools served by the context broker.
const actionSchema = z.object({
  body: z.string().trim().min(1).max(12_000),
  id: z.string().trim().min(1).max(120),
  kind: z.literal("open_github_pull_request"),
  repository: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(240),
});

export interface AutomationActionResult {
  externalReference: string | null;
  kind: string;
  repository?: string;
  title?: string;
}

const manifestSchema = z.object({
  actions: z.array(actionSchema).max(20).refine(
    (actions) => new Set(actions.map((action) => action.id)).size === actions.length,
    "Action IDs must be unique",
  ),
});

interface AutomationActionDependencies {
  beginAttempt: typeof beginAutomationActionAttempt;
  completeAttempt: typeof completeAutomationActionAttempt;
  createPullRequest: typeof createPullRequestFromSandbox;
  failAttempt: typeof failAutomationActionAttempt;
  getRepositories: typeof getAutomationRuntimeRepositories;
}

const defaultDependencies: AutomationActionDependencies = {
  beginAttempt: beginAutomationActionAttempt,
  completeAttempt: completeAutomationActionAttempt,
  createPullRequest: createPullRequestFromSandbox,
  failAttempt: failAutomationActionAttempt,
  getRepositories: getAutomationRuntimeRepositories,
};

function idempotencyKey(runId: string, kind: string, actionId: string): string {
  return createHash("sha256")
    .update(`${runId}\0${kind}\0${actionId}`, "utf8")
    .digest("hex");
}

export function automationActionInstructions(): string {
  return [
    `To request trusted external actions, write JSON to ${automationActionsPath}.`,
    "Use this shape: {\"actions\":[...]}. Each action needs a unique stable id.",
    "Supported actions:",
    '- {"id":"pr-1","kind":"open_github_pull_request","repository":"owner/repo","title":"...","body":"..."}',
    "Only request a pull request after making and testing the intended repository changes.",
    "Do not include secrets in action text, titles, or bodies.",
  ].join("\n");
}

async function loadManifest(session: DaytonaSandboxSession) {
  if (!(await session.pathExists(automationActionsPath))) return { actions: [] };
  const bytes = await session.readFile({ path: automationActionsPath, maxBytes: 200_000 });
  return manifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export async function executeAutomationActions(input: {
  assertActive?: () => Promise<void>;
  automationVersionId: string;
  checkedOutRepositories: CheckedOutRepository[];
  runId: string;
  session: DaytonaSandboxSession;
  signal?: AbortSignal;
}, dependencies: AutomationActionDependencies = defaultDependencies): Promise<
  AutomationActionResult[]
> {
  input.signal?.throwIfAborted();
  const manifest = await loadManifest(input.session);
  if (manifest.actions.length === 0) return [];
  const repositories = await dependencies.getRepositories(input.automationVersionId);
  const results: AutomationActionResult[] = [];

  for (const action of manifest.actions) {
    input.signal?.throwIfAborted();
    await input.assertActive?.();
    const key = idempotencyKey(input.runId, action.kind, action.id);
    // Pull request details are shown on the run page.
    const details = { repository: action.repository, title: action.title };
    const attempt = await dependencies.beginAttempt({
      idempotencyKey: key,
      kind: action.kind,
      redactedInput: details,
      runId: input.runId,
      toolCallId: action.id,
    });
    if (attempt.status === "existing_succeeded") {
      results.push({ externalReference: attempt.externalReference, kind: action.kind, ...details });
      continue;
    }

    try {
      input.signal?.throwIfAborted();
      await input.assertActive?.();
      const checkout = input.checkedOutRepositories.find(
        (candidate) => candidate.repository === action.repository,
      );
      const repository = repositories.find(
        (candidate) => candidate.fullName === action.repository,
      );
      if (!checkout || !repository) {
        throw new Error("Pull request repository is not selected for this automation");
      }
      const pullRequest = await dependencies.createPullRequest({
        baseBranch: checkout.branch,
        baseSha: checkout.sha,
        body: action.body,
        installationId: repository.installationId,
        repository: checkout.repository,
        repositoryPath: checkout.path,
        requestId: attempt.id,
        title: action.title,
        workspaceBaseSha: checkout.workspaceBaseSha,
      }, input.session);
      const externalReference = pullRequest.url;
      await dependencies.completeAttempt({
        attemptId: attempt.id,
        externalReference,
      });
      results.push({ externalReference, kind: action.kind, ...details });
    } catch (error) {
      await dependencies.failAttempt({
        attemptId: attempt.id,
        failureMessage: error instanceof Error ? error.message.slice(0, 2_000) : "Action failed",
      });
      throw error;
    }
  }
  return results;
}
