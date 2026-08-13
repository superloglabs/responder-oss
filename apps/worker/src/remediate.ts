import { run, setDefaultOpenAIKey, setTracingDisabled } from "@openai/agents";
import { Capabilities, SandboxAgent } from "@openai/agents/sandbox";
import {
  DaytonaSandboxClient,
  type DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import { getRuntimeProfile } from "@responder/core/db/runtime-profiles";
import type { RemediationJob } from "@responder/core/jobs";
import { renderIssueFixPrompt } from "@responder/core/investigations/report";
import { sandboxAgentConfig } from "./investigate.js";
import { createPullRequestTool } from "./pull-request.js";
import { checkoutRuntimeRepositories } from "./repositories.js";
import {
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  prepareDaytonaSandbox,
} from "./sandbox.js";

export async function runRemediationAgent(
  job: RemediationJob,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const config = sandboxAgentConfig(environment);
  setDefaultOpenAIKey(config.openAiApiKey);
  setTracingDisabled(true);
  const runtimeProfile = await getRuntimeProfile(job.runtimeProfileId);
  const client = new DaytonaSandboxClient({
    apiKey: config.daytonaApiKey,
    apiUrl: config.daytonaApiUrl,
    name: `responder-remediation-${job.remediationRequestId}`,
    pauseOnExit: false,
    target: config.daytonaTarget,
  });
  let session: DaytonaSandboxSession | null = null;

  try {
    session = await client.create();
    await configureDaytonaSandboxLifecycle(session, config);
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
        "Inspect the relevant code, make the smallest safe fix in exactly one selected repository, and run the narrowest useful checks.",
        `Then call create_pull_request with issue ID ${job.issue.id}. Do not finish without creating the pull request or clearly explaining why no safe code fix is possible.`,
        "Do not expose credentials or secret values. The pull request is the only allowed external change.",
      ]
        .filter((instruction): instruction is string => Boolean(instruction))
        .join("\n\n"),
      capabilities: Capabilities.default(),
      tools: [pullRequestTool],
    });
    const result = await run(agent, renderIssueFixPrompt(job.issue), {
      maxTurns: 20,
      sandbox: { session },
    });
    if (typeof result.finalOutput !== "string" || !result.finalOutput.trim()) {
      throw new Error("OpenAI agent returned an empty remediation result");
    }
    return result.finalOutput.trim();
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
