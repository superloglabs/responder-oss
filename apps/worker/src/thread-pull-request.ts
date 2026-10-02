import { createHash } from "node:crypto";
import { tool } from "@openai/agents";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { getRuntimeRepositories } from "@responder/core/db/investigations";
import { z } from "zod";
import { createPullRequestFromSandbox } from "./github-pull-request.js";
import type { CheckedOutRepository } from "./repositories.js";

export const threadPullRequestToolName = "open_pull_request";

interface ThreadPullRequestDependencies {
  captureEvent: typeof captureAnalyticsEvent;
  createPullRequest: typeof createPullRequestFromSandbox;
  getRepositories: typeof getRuntimeRepositories;
}

const defaultDependencies: ThreadPullRequestDependencies = {
  captureEvent: captureAnalyticsEvent,
  createPullRequest: createPullRequestFromSandbox,
  getRepositories: getRuntimeRepositories,
};

// The branch suffix is derived from the turn, repository, and title, so the
// same request opens the same branch name.
function requestId(investigationId: string, repository: string, title: string): string {
  return createHash("sha256")
    .update(`${investigationId}\0${repository}\0${title}`, "utf8")
    .digest("hex");
}

// Lets a Slack thread publish its checkout changes as a pull request. Only
// repositories selected for tag mode can be targeted. A call repeated with
// the same repository and title in one turn returns the pull request it
// already opened.
export function createThreadPullRequestTool(input: {
  agentConfigVersionId: string;
  investigationId: string;
  organizationId: string;
  repositories: CheckedOutRepository[];
  session: DaytonaSandboxSession;
}, dependencies: ThreadPullRequestDependencies = defaultDependencies) {
  const repositoryNames = [
    ...new Set(input.repositories.map(({ repository }) => repository)),
  ];
  if (repositoryNames.length === 0) {
    throw new Error("No repositories are checked out for this thread");
  }
  const opened = new Map<string, Awaited<ReturnType<typeof createPullRequestFromSandbox>>>();
  return tool({
    name: threadPullRequestToolName,
    description:
      "Open a GitHub pull request with the current changes in a checked-out repository's working tree, against the branch it was checked out from. Make and test the changes first. Returns the pull request URL.",
    parameters: z.object({
      body: z.string().trim().min(1).max(12_000)
        .describe("The Markdown pull request body, following any repository template."),
      repository: z.enum(repositoryNames as [string, ...string[]])
        .describe(`One of: ${repositoryNames.join(", ")}`),
      title: z.string().trim().min(1).max(240),
    }),
    async execute(request) {
      const key = `${request.repository}\0${request.title}`;
      const existing = opened.get(key);
      if (existing) {
        return {
          note: "This pull request was already opened.",
          number: existing.number,
          url: existing.url,
        };
      }
      const checkout = input.repositories.find(
        (candidate) => candidate.repository === request.repository,
      );
      const repository = (await dependencies.getRepositories(input.agentConfigVersionId))
        .find((candidate) => candidate.fullName === request.repository);
      if (!checkout || !repository) {
        throw new Error("The repository is not selected for tag mode");
      }
      const pullRequest = await dependencies.createPullRequest({
        baseBranch: checkout.branch,
        baseSha: checkout.sha,
        body: request.body,
        installationId: repository.installationId,
        repository: repository.fullName,
        repositoryPath: checkout.path,
        requestId: requestId(input.investigationId, request.repository, request.title),
        title: request.title,
        workspaceBaseSha: checkout.workspaceBaseSha,
      }, input.session);
      opened.set(key, pullRequest);
      await dependencies.captureEvent({
        distinctId: `investigation:${input.investigationId}`,
        event: "pr opened",
        organizationId: input.organizationId,
        properties: {
          $process_person_profile: false,
          agent_config_version_id: input.agentConfigVersionId,
          investigation_id: input.investigationId,
          pr_number: pullRequest.number,
          pr_url: pullRequest.url,
          repository: repository.fullName,
          slack_thread_mode: true,
        },
      }).catch(() => undefined);
      return {
        branch: pullRequest.branch,
        changedFiles: pullRequest.changedFiles,
        number: pullRequest.number,
        url: pullRequest.url,
      };
    },
  });
}
