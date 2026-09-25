import { createHash } from "node:crypto";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  beginAutomationActionAttempt,
  completeAutomationActionAttempt,
  failAutomationActionAttempt,
  getAutomationRuntimeConnections,
  getAutomationRuntimeRepositories,
} from "@responder/core/db/automations";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import {
  openSlackDirectMessage,
  postSlackMessage,
} from "@responder/core/integrations/slack";
import { z } from "zod";
import { automationWorkspaceRoot } from "./automation-harness.js";
import { createPullRequestFromSandbox } from "./github-pull-request.js";
import type { CheckedOutRepository } from "./repositories.js";

export const automationActionsPath = `${automationWorkspaceRoot}/.responder/actions.json`;

const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    body: z.string().trim().min(1).max(12_000),
    id: z.string().trim().min(1).max(120),
    kind: z.literal("open_github_pull_request"),
    repository: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(240),
  }),
  z.object({
    id: z.string().trim().min(1).max(120),
    integrationAccountId: z.uuid().optional(),
    kind: z.literal("send_slack_message"),
    target: z.discriminatedUnion("type", [
      z.object({ channelId: z.string().trim().min(1).max(255), type: z.literal("channel") }),
      z.object({ type: z.literal("dm"), userId: z.string().trim().min(1).max(255) }),
    ]),
    text: z.string().trim().min(1).max(40_000),
  }),
]);

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
  getConnections: typeof getAutomationRuntimeConnections;
  getRepositories: typeof getAutomationRuntimeRepositories;
  openDirectMessage: typeof openSlackDirectMessage;
  postMessage: typeof postSlackMessage;
}

const defaultDependencies: AutomationActionDependencies = {
  beginAttempt: beginAutomationActionAttempt,
  completeAttempt: completeAutomationActionAttempt,
  createPullRequest: createPullRequestFromSandbox,
  failAttempt: failAutomationActionAttempt,
  getConnections: getAutomationRuntimeConnections,
  getRepositories: getAutomationRuntimeRepositories,
  openDirectMessage: openSlackDirectMessage,
  postMessage: postSlackMessage,
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
    '- {"id":"slack-1","kind":"send_slack_message","target":{"type":"channel","channelId":"..."},"text":"..."}',
    "If more than one Slack connection is selected, include its integrationAccountId.",
    '- For a DM, use target {"type":"dm","userId":"..."}.',
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
  const [repositories, connections] = await Promise.all([
    dependencies.getRepositories(input.automationVersionId),
    dependencies.getConnections(input.automationVersionId),
  ]);
  const results: AutomationActionResult[] = [];

  for (const action of manifest.actions) {
    input.signal?.throwIfAborted();
    await input.assertActive?.();
    const key = idempotencyKey(input.runId, action.kind, action.id);
    const redactedInput = action.kind === "open_github_pull_request"
      ? { repository: action.repository, title: action.title }
      : { integrationAccountId: action.integrationAccountId, target: action.target };
    const attempt = await dependencies.beginAttempt({
      idempotencyKey: key,
      kind: action.kind,
      redactedInput,
      runId: input.runId,
      toolCallId: action.id,
    });
    // Pull request details are shown on the run page.
    const details = action.kind === "open_github_pull_request"
      ? { repository: action.repository, title: action.title }
      : {};
    if (attempt.status === "existing_succeeded") {
      results.push({ externalReference: attempt.externalReference, kind: action.kind, ...details });
      continue;
    }

    try {
      input.signal?.throwIfAborted();
      await input.assertActive?.();
      let externalReference: string;
      if (action.kind === "open_github_pull_request") {
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
        externalReference = pullRequest.url;
      } else {
        const slackConnections = [
          ...new Map(
            connections
              .filter((candidate) => candidate.provider === "slack")
              .map((candidate) => [candidate.id, candidate]),
          ).values(),
        ];
        const connection = action.integrationAccountId
          ? slackConnections.find((candidate) => candidate.id === action.integrationAccountId)
          : slackConnections.length === 1 ? slackConnections[0] : undefined;
        if (!connection?.encryptedCredentials) {
          throw new Error("Slack connection is not selected for this automation");
        }
        const credentials = decryptCredentials<Record<string, unknown>>(
          connection.encryptedCredentials,
        );
        if (typeof credentials.accessToken !== "string" || !credentials.accessToken) {
          throw new Error("Slack connection credentials are unavailable");
        }
        const channelId = action.target.type === "channel"
          ? action.target.channelId
          : await dependencies.openDirectMessage({
              accessToken: credentials.accessToken,
              userId: action.target.userId,
            });
        input.signal?.throwIfAborted();
        await input.assertActive?.();
        const timestamp = await dependencies.postMessage({
          accessToken: credentials.accessToken,
          channelId,
          clientMessageId: attempt.id,
          text: action.text,
        });
        externalReference = `${channelId}:${timestamp ?? "sent"}`;
      }
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
