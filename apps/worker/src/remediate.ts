import {
  DaytonaSandboxClient,
  type DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import {
  getRuntimeRepositories,
  type RuntimeRepository,
} from "@responder/core/db/investigations";
import {
  getExecutableIssuePullRequest,
  markIssuePullRequestCreated,
  markIssuePullRequestStarted,
} from "@responder/core/db/pull-requests";
import {
  daytonaClientOptions,
  requireDaytonaClientConfig,
} from "@responder/core/daytona-config";
import type { RemediationJob } from "@responder/core/jobs";
import type { IssueRemediationSubmission } from "@responder/core/investigations/report";
import { refreshIssuePullRequestSlackMessages } from "@responder/core/integrations/slack-remediations";
import {
  createPullRequestFromSandbox,
} from "./github-pull-request.js";
import { checkoutRuntimeRepository } from "./repositories.js";
import {
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  createDaytonaSandboxSession,
  prepareDaytonaPatchSandbox,
} from "./sandbox.js";

type CodeChangeRemediation = Extract<
  IssueRemediationSubmission,
  { type: "code_change" }
>;

interface SelectedProposedChange {
  diff: string;
  pullRequest?: { body: string; title: string };
  repository: RuntimeRepository;
}

export function selectProposedChange(
  remediation: IssueRemediationSubmission | undefined,
  targetRepository: string | undefined,
  repositories: RuntimeRepository[],
): SelectedProposedChange {
  if (remediation?.type !== "code_change") {
    throw new Error("The pull request does not have a proposed code diff");
  }

  let change: CodeChangeRemediation["changes"][number] | undefined;
  if (targetRepository) {
    change = remediation.changes.find(
      (candidate) => candidate.repository === targetRepository,
    );
    if (!change && remediation.changes.length === 1) {
      const onlyChange = remediation.changes[0];
      if (onlyChange?.repository === null) change = onlyChange;
    }
  } else if (remediation.changes.length === 1) {
    change = remediation.changes[0];
  }
  if (!change) {
    throw new Error("The pull request does not have one target repository diff");
  }

  const repositoryName = targetRepository ?? change.repository;
  const repository = repositoryName
    ? repositories.find((candidate) => candidate.fullName === repositoryName)
    : repositories.length === 1
      ? repositories[0]
      : undefined;
  if (!repository) {
    throw new Error("The proposed diff does not identify one attached repository");
  }
  if (change.repository && change.repository !== repository.fullName) {
    throw new Error("The proposed diff does not match the target repository");
  }
  return {
    diff: change.diff,
    ...(change.pullRequest ? { pullRequest: change.pullRequest } : {}),
    repository,
  };
}

export function proposedPullRequestContent(
  remediation: CodeChangeRemediation,
  selected: SelectedProposedChange,
): { body: string; title: string } {
  return selected.pullRequest ?? {
    body: remediation.description,
    title: remediation.title,
  };
}

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

export async function applyProposedDiff(
  session: DaytonaSandboxSession,
  repositoryPath: string,
  diff: string,
): Promise<void> {
  const patchPath = "/home/daytona/workspace/.responder/proposed.patch";
  await session.materializeEntry({
    entry: { type: "file", content: `${diff.trim()}\n` },
    path: patchPath,
  });
  const output = await session.execCommand({
    cmd: `git apply --whitespace=nowarn ${patchPath}`,
    maxOutputTokens: 2_000,
    workdir: repositoryPath,
  });
  if (!commandSucceeded(output)) {
    throw new Error("The proposed diff no longer applies cleanly");
  }
}

export async function runProposedRemediation(
  job: RemediationJob,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const request = await getExecutableIssuePullRequest({
    agentConfigVersionId: job.config.id,
    investigationId: job.investigationId,
    issueId: job.issue.id,
    organizationId: job.config.organizationId,
    requestId: job.remediationRequestId,
  });
  const repositories = await getRuntimeRepositories(job.config.id);
  const selected = selectProposedChange(
    request.selectedRemediation ?? job.selectedRemediation,
    job.targetRepository,
    repositories,
  );

  await markIssuePullRequestStarted(request.requestId);
  await refreshIssuePullRequestSlackMessages(request.requestId);

  const config = requireDaytonaClientConfig(environment);
  const sandboxName = `responder-remediation-${job.remediationRequestId}`;
  const client = new DaytonaSandboxClient({
    ...daytonaClientOptions(config),
    name: sandboxName,
    pauseOnExit: false,
  });
  let session: DaytonaSandboxSession | null = null;

  try {
    session = await createDaytonaSandboxSession(client, config, sandboxName);
    await configureDaytonaSandboxLifecycle(session, config);
    await prepareDaytonaPatchSandbox(session);
    const checkout = await checkoutRuntimeRepository(
      session,
      job.config.id,
      selected.repository.fullName,
    );
    await applyProposedDiff(session, checkout.path, selected.diff);

    const remediation = request.selectedRemediation ?? job.selectedRemediation;
    if (remediation?.type !== "code_change") {
      throw new Error("The pull request does not have a proposed code diff");
    }
    const pullRequest = proposedPullRequestContent(remediation, selected);
    const result = await createPullRequestFromSandbox(
      {
        baseBranch: checkout.branch,
        baseSha: checkout.sha,
        body: pullRequest.body,
        installationId: selected.repository.installationId,
        repository: selected.repository.fullName,
        repositoryPath: checkout.path,
        requestId: request.requestId,
        title: pullRequest.title,
        workspaceBaseSha: checkout.workspaceBaseSha,
      },
      session,
    );
    await markIssuePullRequestCreated({
      requestId: request.requestId,
      repositoryFullName: selected.repository.fullName,
      branch: result.branch,
      pullRequestNumber: result.number,
      pullRequestUrl: result.url,
    });
    await refreshIssuePullRequestSlackMessages(request.requestId);
    await captureAnalyticsEvent({
      distinctId: `investigation:${job.investigationId}`,
      event: "pr opened",
      organizationId: job.config.organizationId,
      properties: {
        $process_person_profile: false,
        agent_config_version_id: job.config.id,
        investigation_id: job.investigationId,
        issue_id: job.issue.id,
        pr_number: result.number,
        pr_url: result.url,
        repository: selected.repository.fullName,
      },
    });
    return result.url;
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
