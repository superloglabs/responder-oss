import { tool } from "@openai/agents";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { getRuntimeRepositories } from "@responder/core/db/investigations";
import {
  failIssuePullRequest,
  getExecutableIssuePullRequest,
  markIssuePullRequestCreated,
  markIssuePullRequestStarted,
} from "@responder/core/db/pull-requests";
import { z } from "zod";
import {
  buildPullRequestBody,
  createPullRequestFromSandbox,
} from "./github-pull-request.js";

const checkedOutRepositoriesSchema = z.object({
  repositories: z.array(
    z.object({
      branch: z.string().min(1),
      path: z.string().min(1),
      repository: z.string().min(1),
      sha: z.string().regex(/^[a-f0-9]{40}$/i),
      workspaceBaseSha: z.string().regex(/^[a-f0-9]{40}$/i),
    }),
  ),
});

export function createPullRequestTool(input: {
  agentConfigVersionId: string;
  investigationId: string;
  organizationId: string;
  pullRequestRequestId?: string;
  session: DaytonaSandboxSession;
}) {
  return tool({
    name: "create_pull_request",
    description:
      "Create a GitHub pull request from changes made in one selected repository. Call this only after the report tool returns the matching issue ID, or when this run explicitly asks for that issue to be fixed.",
    parameters: z.object({
      issueId: z.uuid(),
      repository: z.string().min(1),
      summary: z.string().trim().min(1).max(4_000),
      testing: z.string().trim().min(1).max(2_000),
    }),
    async execute(requestedPullRequest) {
      const request = await getExecutableIssuePullRequest({
        agentConfigVersionId: input.agentConfigVersionId,
        investigationId: input.investigationId,
        issueId: requestedPullRequest.issueId,
        organizationId: input.organizationId,
        ...(input.pullRequestRequestId
          ? { requestId: input.pullRequestRequestId }
          : {}),
      });
      await markIssuePullRequestStarted(request.requestId);
      let published = false;

      try {
        const repositories = await getRuntimeRepositories(
          input.agentConfigVersionId,
        );
        const repository = repositories.find(
          (candidate) => candidate.fullName === requestedPullRequest.repository,
        );
        if (!repository) {
          throw new Error("The selected repository is not configured for this agent");
        }

        const manifestBytes = await input.session.readFile({
          path: "/home/daytona/workspace/.responder/repositories.json",
        });
        const manifest = checkedOutRepositoriesSchema.parse(
          JSON.parse(new TextDecoder().decode(manifestBytes)),
        );
        const checkout = manifest.repositories.find(
          (candidate) => candidate.repository === requestedPullRequest.repository,
        );
        if (!checkout) throw new Error("The selected repository is not checked out");

        const result = await createPullRequestFromSandbox(
          {
            baseBranch: checkout.branch,
            baseSha: checkout.sha,
            body: buildPullRequestBody({
              issue: request.issueDescription,
              summary: requestedPullRequest.summary,
              testing: requestedPullRequest.testing,
            }),
            installationId: repository.installationId,
            repository: repository.fullName,
            repositoryPath: checkout.path,
            requestId: request.requestId,
            title: `Fix: ${request.issueTitle}`.slice(0, 240),
            workspaceBaseSha: checkout.workspaceBaseSha,
          },
          input.session,
        );
        published = true;
        await markIssuePullRequestCreated({
          requestId: request.requestId,
          repositoryFullName: repository.fullName,
          branch: result.branch,
          pullRequestNumber: result.number,
          pullRequestUrl: result.url,
        });
        await captureAnalyticsEvent({
          distinctId: `investigation:${input.investigationId}`,
          event: "pr opened",
          organizationId: input.organizationId,
          properties: {
            $process_person_profile: false,
            agent_config_version_id: input.agentConfigVersionId,
            investigation_id: input.investigationId,
            issue_id: requestedPullRequest.issueId,
            pr_number: result.number,
            pr_url: result.url,
            repository: repository.fullName,
          },
        });
        return {
          created: true,
          changedFiles: result.changedFiles,
          pullRequestNumber: result.number,
          pullRequestUrl: result.url,
        };
      } catch (error) {
        if (!published) {
          await failIssuePullRequest(
            request.requestId,
            error instanceof Error ? error.message : "Unable to create pull request",
          );
        }
        throw error;
      }
    },
  });
}
