import { renderInvestigationPromptPart, type InvestigationPromptParts } from "@responder/core/investigations/prompt-parts";
import { tool } from "@openai/agents";
import { submitInvestigationReport } from "@responder/core/db/issues";
import { saveInvestigationReplayReport } from "@responder/core/db/investigations";
import { deliverInvestigationToSlack } from "@responder/core/integrations/slack-delivery";
import {
  investigationReportSubmissionSchema,
  type InvestigationReportSubmission,
} from "@responder/core/investigations/report";
import { embedNewIssues } from "./issue-embeddings.js";
import { attachRepositoryBasesToReport } from "./remediation-bases.js";
import { assertNoDaytonaSecretPlaceholders } from "./secret-safety.js";

function reportToolResult(input: {
  automaticPullRequestIssueIds: string[];
  promptParts?: InvestigationPromptParts;
  deliveryWarnings?: string[];
  issueIds: string[];
  linearTicketRequestIds?: string[];
  slackMarkdown?: string;
}) {
  return {
    accepted: true,
    automaticPullRequestIssueIds: input.automaticPullRequestIssueIds,
    deliveryWarnings: input.deliveryWarnings ?? [],
    issueIds: input.issueIds,
    instruction: [
      renderInvestigationPromptPart("reportSaved", input.promptParts),
      input.automaticPullRequestIssueIds.length > 0
        ? renderInvestigationPromptPart("reportPullRequests", input.promptParts, { issueIds: input.automaticPullRequestIssueIds.join(", ") })
        : null,
      input.linearTicketRequestIds?.length
        ? renderInvestigationPromptPart("reportLinearTickets", input.promptParts, { requestIds: input.linearTicketRequestIds.join(", ") })
        : null,
    ].filter(Boolean).join("\n\n"),
    ...(input.slackMarkdown !== undefined
      ? { slackMarkdown: input.slackMarkdown }
      : {}),
  };
}

export async function deliverCompletedInvestigationWithWarnings(
  investigationId: string,
  deliveryRunId: string,
): Promise<string[]> {
  try {
    return await deliverInvestigationToSlack(investigationId, deliveryRunId);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Slack delivery failed";
    console.error(
      JSON.stringify({
        error: message,
        errorStack: error instanceof Error ? error.stack : undefined,
        event: "investigation_slack_delivery_failed",
        investigationId,
      }),
    );
    return [message];
  }
}

export async function submitInvestigationReportForRun(input: {
  investigationId: string;
  organizationId: string;
  promptParts?: InvestigationPromptParts;
  report: InvestigationReportSubmission;
  repositories?: Array<{ branch: string; repository: string; sha: string }>;
  environment?: NodeJS.ProcessEnv;
  allowCodeChanges?: boolean;
  onAutomaticPullRequestRequests?: (requestIds: string[]) => Promise<void>;
  onLinearTicketRequests?: (requestIds: string[]) => Promise<void>;
}) {
  if (
    input.allowCodeChanges === false &&
    input.report.issues.some(
      (issue) =>
        issue.resolution === "new" &&
        issue.remediations.some((remediation) => remediation.type === "code_change"),
    )
  ) {
    throw new Error("Scan reports cannot propose or publish code changes");
  }
  const report = input.repositories
    ? attachRepositoryBasesToReport(input.report, input.repositories)
    : input.report;
  assertNoDaytonaSecretPlaceholders(report, "Investigation report");
  const newIssues = report.issues.filter(
    (issue) => issue.resolution === "new",
  );
  const newIssueEmbeddings = await embedNewIssues(
    newIssues,
    input.environment,
  );
  const result = await submitInvestigationReport({
    investigationId: input.investigationId,
    organizationId: input.organizationId,
    submission: {
      report,
      newIssueEmbeddings,
    },
  });
  await input.onAutomaticPullRequestRequests?.(
    result.automaticPullRequestRequestIds,
  );
  try {
    await input.onLinearTicketRequests?.(
      result.linearTicketRequests.map((request) => request.requestId),
    );
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "linear_ticket_queue_handoff_failed",
      investigationId: input.investigationId,
    }));
  }
  return reportToolResult({
    promptParts: input.promptParts,
    issueIds: result.issues.map((issue) => issue.id),
    automaticPullRequestIssueIds: result.automaticPullRequestIssueIds,
    slackMarkdown: result.markdown,
    linearTicketRequestIds: result.linearTicketRequests.map(
      (request) => request.requestId,
    ),
  });
}

export function createSubmitInvestigationReportTool(input: {
  investigationId: string;
  organizationId: string;
  promptParts?: InvestigationPromptParts;
  repositories?: Array<{ branch: string; repository: string; sha: string }>;
  environment?: NodeJS.ProcessEnv;
  allowCodeChanges?: boolean;
  onAutomaticPullRequestRequests?: (requestIds: string[]) => Promise<void>;
  onLinearTicketRequests?: (requestIds: string[]) => Promise<void>;
}) {
  return tool({
    name: "submit_investigation_report",
    description: renderInvestigationPromptPart("reportToolDescription", input.promptParts),
    parameters: investigationReportSubmissionSchema,
    async execute(report) {
      return submitInvestigationReportForRun({
        investigationId: input.investigationId,
        organizationId: input.organizationId,
        report,
        promptParts: input.promptParts,
        repositories: input.repositories,
        environment: input.environment,
        allowCodeChanges: input.allowCodeChanges,
        onAutomaticPullRequestRequests:
          input.onAutomaticPullRequestRequests,
        onLinearTicketRequests: input.onLinearTicketRequests,
      });
    },
  });
}

export function createCaptureInvestigationReplayReportTool(input: {
  investigationId: string;
  organizationId: string;
  promptParts?: InvestigationPromptParts;
}) {
  return tool({
    name: "submit_investigation_report",
    description: renderInvestigationPromptPart("reportToolDescription", input.promptParts),
    parameters: investigationReportSubmissionSchema,
    async execute(report) {
      return captureInvestigationReplayReport({ ...input, report });
    },
  });
}

export async function captureInvestigationReplayReport(input: {
  investigationId: string;
  organizationId: string;
  promptParts?: InvestigationPromptParts;
  report: InvestigationReportSubmission;
}) {
  assertNoDaytonaSecretPlaceholders(input.report, "Investigation replay report");
  try {
    await saveInvestigationReplayReport({
      investigationId: input.investigationId,
      organizationId: input.organizationId,
      report: input.report,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "investigation_replay_report_capture_failed",
        investigationId: input.investigationId,
        organizationId: input.organizationId,
      }),
    );
    throw error;
  }
  console.info(
    JSON.stringify({
      event: "investigation_replay_report_captured",
      investigationId: input.investigationId,
      organizationId: input.organizationId,
    }),
  );
  return reportToolResult({
    promptParts: input.promptParts,
    automaticPullRequestIssueIds: [],
    // Replays must satisfy the same final-response contract without delivery.
    slackMarkdown: [input.report.headline, input.report.summary]
      .map((text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"))
      .join("\n\n"),
    issueIds: input.report.issues
      .filter((issue) => issue.resolution === "existing")
      .map((issue) => issue.issueId),
  });
}
