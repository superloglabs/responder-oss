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
import type { InvestigationInput } from "@responder/core/db/schema";
import type { IssueEvidence } from "@responder/core/investigations/report";
import { refreshIssuePullRequestSlackMessages } from "@responder/core/integrations/slack-remediations";
import { responderIssueUrl as buildResponderIssueUrl } from "@responder/core/responder-urls";
import { z } from "zod";
import {
  buildPullRequestBody,
  createPullRequestFromSandbox,
} from "./github-pull-request.js";
import type { CheckedOutRepository } from "./repositories.js";

export function responderIssueUrl(
  issueId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const origin = environment.RESPONDER_APP_URL ?? environment.BETTER_AUTH_URL;
  if (!origin) return undefined;
  try {
    return buildResponderIssueUrl(issueId, origin);
  } catch {
    return undefined;
  }
}

export function sentryIssueUrl(
  input: InvestigationInput,
  evidence: IssueEvidence[],
): string | undefined {
  const candidates = [
    ...(input.provider === "sentry" && input.sourceUrl ? [input.sourceUrl] : []),
    ...evidence.flatMap((item) =>
      item.source === "sentry" && item.url ? [item.url] : [],
    ),
  ];
  return candidates.find((candidate) => {
    try {
      const url = new URL(candidate);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        url.pathname.split("/").includes("issues")
      );
    } catch {
      return false;
    }
  });
}

export function createPullRequestTool(input: {
  agentConfigVersionId: string;
  investigationId: string;
  organizationId: string;
  pullRequestRequestId?: string;
  repositories: CheckedOutRepository[];
  session: DaytonaSandboxSession;
}) {
  const configuredRepositoryNames = [
    ...new Set(input.repositories.map(({ repository }) => repository)),
  ];
  if (configuredRepositoryNames.length === 0) {
    throw new Error("No repositories are configured for this agent");
  }
  const repositorySchema = z
    .enum(configuredRepositoryNames as [string, ...string[]])
    .describe(`One of: ${configuredRepositoryNames.join(", ")}`);

  return tool({
    name: "create_pull_request",
    description:
      "Create a GitHub pull request from changes made in one selected repository. Call this only after the report tool returns the matching issue ID, or when this run explicitly asks for that issue to be fixed.",
    parameters: z.object({
      issueId: z.uuid(),
      repository: repositorySchema,
      failureMechanism: z
        .string()
        .trim()
        .min(1)
        .max(1_000)
        .describe(
          "In one or two very short sentences, explain what failed and why. Use extremely simple language that anyone can understand at a glance. Use no jargon, acronyms, code names, or implementation details.",
        ),
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
      await refreshIssuePullRequestSlackMessages(request.requestId);
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

        const checkout = input.repositories.find(
          (candidate) => candidate.repository === requestedPullRequest.repository,
        );
        if (!checkout) throw new Error("The selected repository is not checked out");

        const result = await createPullRequestFromSandbox(
          {
            baseBranch: checkout.branch,
            baseSha: checkout.sha,
            body: buildPullRequestBody({
              failureMechanism: requestedPullRequest.failureMechanism,
              responderIssueUrl: responderIssueUrl(requestedPullRequest.issueId),
              sentryIssueUrl: sentryIssueUrl(
                request.investigationInput,
                [...request.issueEvidence, ...request.investigationEvidence],
              ),
              summary: requestedPullRequest.summary,
              testing: requestedPullRequest.testing,
            }),
            installationId: repository.installationId,
            repository: repository.fullName,
            repositoryPath: checkout.path,
            requestId: request.requestId,
            title: `Fix: ${request.selectedRemediation?.title ?? request.issueTitle}`.slice(0, 240),
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
        await refreshIssuePullRequestSlackMessages(request.requestId);
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
          await refreshIssuePullRequestSlackMessages(request.requestId);
        }
        throw error;
      }
    },
  });
}
