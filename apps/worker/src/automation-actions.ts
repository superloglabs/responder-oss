import { createHash } from "node:crypto";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  beginAutomationActionAttempt,
  completeAutomationActionAttempt,
  failAutomationActionAttempt,
  getAutomationRuntimeRepositories,
} from "@responder/core/db/automations";
import { z } from "zod";
import type { AutomationNotification } from "@responder/core/automations/config";
import {
  automationToolServerName,
  postNotificationToolName,
} from "./automation-harness.js";
import {
  agentNotificationMessage,
  postAutomationNotification,
} from "./automation-notifications.js";
import {
  githubLoginPattern,
  maxNotificationLength,
  maxPullRequestPeople,
  openPullRequestToolName,
  type AutomationToolRequest,
  type AutomationToolResult,
} from "./automation-tools.js";
import { createPullRequestFromSandbox } from "./github-pull-request.js";
import { createGitHubReadTools } from "./github-read-tools.js";
import type { CheckedOutRepository } from "./repositories.js";

// Slack writes are live MCP tools served by the context broker. Pull requests
// are live tools served by the worker, which reads the changes from the
// sandbox.
const notificationSchema = z.object({
  text: z.string().trim().min(1).max(maxNotificationLength),
});

const githubLoginsSchema = z
  .array(z.string().trim().regex(new RegExp(githubLoginPattern, "u")).transform((login) => login.replace(/^@/u, "")))
  .max(maxPullRequestPeople)
  .optional();

const pullRequestSchema = z.object({
  assignees: githubLoginsSchema,
  body: z.string().trim().min(1).max(12_000),
  repository: z.string().trim().min(1).max(255),
  reviewers: githubLoginsSchema,
  title: z.string().trim().min(1).max(240),
});

export interface AutomationActionResult {
  externalReference: string | null;
  kind: string;
  repository?: string;
  title?: string;
}

interface AutomationActionDependencies {
  beginAttempt: typeof beginAutomationActionAttempt;
  completeAttempt: typeof completeAutomationActionAttempt;
  createPullRequest: typeof createPullRequestFromSandbox;
  failAttempt: typeof failAutomationActionAttempt;
  getRepositories: typeof getAutomationRuntimeRepositories;
  postNotification: typeof postAutomationNotification;
  readTools?: Parameters<typeof createGitHubReadTools>[1];
}

const defaultDependencies: AutomationActionDependencies = {
  beginAttempt: beginAutomationActionAttempt,
  completeAttempt: completeAutomationActionAttempt,
  createPullRequest: createPullRequestFromSandbox,
  failAttempt: failAutomationActionAttempt,
  getRepositories: getAutomationRuntimeRepositories,
  postNotification: postAutomationNotification,
};

function idempotencyKey(runId: string, kind: string, identity: unknown): string {
  return createHash("sha256")
    .update(`${runId}\0${kind}\0${JSON.stringify(identity)}`, "utf8")
    .digest("hex");
}

export function automationActionInstructions(notificationChannels: string[] = []): string {
  return [
    ...(notificationChannels.length > 0
      ? [`This automation reports to Slack: ${notificationChannels.join(", ")}. When you finish, post your complete result there with the ${postNotificationToolName} tool from the ${automationToolServerName} tool server. That post is what people read. If you do not post, your final reply is posted for you.`]
      : []),
    `The ${automationToolServerName} tool server works with the selected repositories as the Responder GitHub App; the sandbox has no GitHub credentials of its own.`,
    "- github_api reads the GitHub REST API: pull requests, commits, compares, issues, and files. Use it instead of unauthenticated requests to api.github.com.",
    "- fetch_ref brings another branch, tag, pull request head, or commit into the checkout as github/<ref> for git diff. The checkouts have no history.",
    `- ${openPullRequestToolName} opens a pull request after you make and test the repository changes. It publishes the working tree changes on a new branch and returns the pull request URL, so you can link the pull request in messages you post. When the instructions name people to review or own the pull request, pass their GitHub usernames as reviewers or assignees.`,
    "Do not include secrets in pull request titles or bodies.",
  ].join("\n");
}

function toolText(value: unknown): AutomationToolResult {
  return { content: [{ text: JSON.stringify(value), type: "text" }] };
}

function toolError(message: string): AutomationToolResult {
  return { content: [{ text: message, type: "text" }], isError: true };
}

// Answers the agent's tool calls for one run. A call repeated with the same
// repository and title returns the pull request it already opened.
export function createAutomationToolHandler(input: {
  assertActive?: () => Promise<void>;
  automationVersionId: string;
  checkedOutRepositories: CheckedOutRepository[];
  // Where post_notification posts, for a run whose automation has channels.
  notifications?: {
    channelNames: Map<string, string>;
    notifications: AutomationNotification[];
    onPosted(notification: AutomationNotification): void;
    organizationId: string;
    runUrl: string | null;
  };
  onAction(action: AutomationActionResult): Promise<void>;
  runId: string;
  session: DaytonaSandboxSession;
  signal?: AbortSignal;
}, dependencies: AutomationActionDependencies = defaultDependencies) {
  const channelName = (notification: AutomationNotification) =>
    `#${input.notifications?.channelNames.get(`${notification.integrationAccountId}:${notification.channelId}`) ?? notification.channelId}`;

  // Each channel is its own attempt, so posting the same text again reaches
  // only the channels that did not get it.
  async function postNotification(args: unknown): Promise<AutomationToolResult> {
    const target = input.notifications;
    if (!target?.notifications.length) return toolError("This automation has no notification channels.");
    const parsed = notificationSchema.safeParse(args);
    if (!parsed.success) return toolError("Invalid tool arguments");
    const kind = "send_slack_message";
    const message = agentNotificationMessage(parsed.data.text, target.runUrl);
    const alreadyPosted: string[] = [];
    const posted: string[] = [];
    const failed: Array<{ channel: string; error: string }> = [];
    for (const notification of target.notifications) {
      const channel = channelName(notification);
      input.signal?.throwIfAborted();
      await input.assertActive?.();
      const attempt = await dependencies.beginAttempt({
        idempotencyKey: idempotencyKey(input.runId, kind, [
          "notification",
          notification.integrationAccountId,
          notification.channelId,
          parsed.data.text,
        ]),
        kind,
        redactedInput: { channel },
        retryFailed: true,
        runId: input.runId,
        toolCallId: postNotificationToolName,
      });
      if (attempt.status === "existing_succeeded") {
        alreadyPosted.push(channel);
        target.onPosted(notification);
        continue;
      }
      const [delivery] = await dependencies.postNotification({
        ...message,
        notifications: [notification],
        organizationId: target.organizationId,
        seed: attempt.id,
      });
      if (!delivery || "error" in delivery) {
        const error = delivery?.error instanceof Error ? delivery.error.message.slice(0, 200) : "Failed";
        await dependencies.failAttempt({ attemptId: attempt.id, failureMessage: error });
        failed.push({ channel, error });
        continue;
      }
      const externalReference = `${notification.channelId}:${delivery.timestamp ?? "sent"}`;
      await dependencies.completeAttempt({ attemptId: attempt.id, externalReference });
      await input.onAction({ externalReference, kind });
      target.onPosted(notification);
      posted.push(channel);
    }
    if (posted.length === 0 && alreadyPosted.length === 0) {
      return toolError(`Unable to post the notification: ${failed.map((item) => `${item.channel}: ${item.error}`).join("; ")}`);
    }
    return toolText({
      ...(alreadyPosted.length > 0 ? { alreadyPosted } : {}),
      posted,
      ...(failed.length > 0 ? { failed } : {}),
    });
  }

  let repositories: ReturnType<typeof dependencies.getRepositories> | undefined;
  const selectedRepositories = () => {
    if (!repositories) {
      repositories = dependencies.getRepositories(input.automationVersionId);
      repositories.catch(() => { repositories = undefined; });
    }
    return repositories;
  };
  const readTools: Record<string, ((args: unknown) => Promise<AutomationToolResult>) | undefined> =
    createGitHubReadTools({
      checkedOutRepositories: input.checkedOutRepositories,
      repositories: selectedRepositories,
      session: input.session,
    }, dependencies.readTools);
  return async (request: AutomationToolRequest): Promise<AutomationToolResult> => {
    if (request.name === postNotificationToolName) return postNotification(request.arguments);
    const readTool = readTools[request.name];
    if (readTool) return readTool(request.arguments);
    if (request.name !== openPullRequestToolName) return toolError("Unknown tool");
    const parsed = pullRequestSchema.safeParse(request.arguments);
    if (!parsed.success) return toolError("Invalid tool arguments");
    const action = parsed.data;
    const kind = "open_github_pull_request";
    // Pull request details are shown on the run page.
    const details = { repository: action.repository, title: action.title };

    input.signal?.throwIfAborted();
    await input.assertActive?.();
    const attempt = await dependencies.beginAttempt({
      idempotencyKey: idempotencyKey(input.runId, kind, [action.repository, action.title]),
      kind,
      redactedInput: details,
      retryFailed: true,
      runId: input.runId,
      toolCallId: openPullRequestToolName,
    });
    if (attempt.status === "existing_succeeded") {
      return toolText({
        ...details,
        note: "This pull request was already opened in this run.",
        url: attempt.externalReference,
      });
    }

    let pullRequest: Awaited<ReturnType<typeof createPullRequestFromSandbox>>;
    try {
      input.signal?.throwIfAborted();
      await input.assertActive?.();
      const checkout = input.checkedOutRepositories.find(
        (candidate) => candidate.repository === action.repository,
      );
      const repository = (await selectedRepositories()).find(
        (candidate) => candidate.fullName === action.repository,
      );
      if (!checkout || !repository) {
        throw new Error("Pull request repository is not selected for this automation");
      }
      pullRequest = await dependencies.createPullRequest({
        assignees: action.assignees,
        baseBranch: checkout.branch,
        baseSha: checkout.sha,
        body: action.body,
        installationId: repository.installationId,
        repository: checkout.repository,
        repositoryPath: checkout.path,
        requestId: attempt.id,
        reviewers: action.reviewers,
        title: action.title,
        workspaceBaseSha: checkout.workspaceBaseSha,
      }, input.session);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "Action failed";
      await dependencies.failAttempt({ attemptId: attempt.id, failureMessage: message });
      input.signal?.throwIfAborted();
      return toolError(`Unable to open the pull request: ${message.slice(0, 500)}`);
    }
    await dependencies.completeAttempt({
      attemptId: attempt.id,
      externalReference: pullRequest.url,
    });
    await input.onAction({ externalReference: pullRequest.url, kind, ...details });
    return toolText({
      ...details,
      assignees: pullRequest.assignees,
      branch: pullRequest.branch,
      changedFiles: pullRequest.changedFiles,
      number: pullRequest.number,
      peopleErrors: pullRequest.peopleErrors,
      reviewers: pullRequest.reviewers,
      url: pullRequest.url,
    });
  };
}
