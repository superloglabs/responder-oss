import { tool } from "@openai/agents";
import { submitInvestigationReport } from "@responder/core/db/issues";
import { saveInvestigationReplayReport } from "@responder/core/db/investigations";
import { deliverInvestigationToSlack } from "@responder/core/integrations/slack-delivery";
import {
  investigationReportSubmissionSchema,
  type InvestigationReportSubmission,
} from "@responder/core/investigations/report";
import { embedNewIssues } from "./issue-embeddings.js";

const submitInvestigationReportDescription =
  "Submit the final structured investigation report. You must call this exactly once before giving your final response. Responder delivers its Slack messages after the investigation finishes.";

function reportToolResult(input: {
  automaticPullRequestIssueIds: string[];
  deliveryWarnings?: string[];
  issueIds: string[];
  slackMarkdown?: string;
}) {
  return {
    accepted: true,
    automaticPullRequestIssueIds: input.automaticPullRequestIssueIds,
    deliveryWarnings: input.deliveryWarnings ?? [],
    issueIds: input.issueIds,
    instruction:
      input.automaticPullRequestIssueIds.length > 0
        ? `The report was saved. Separate remediation jobs will handle pull request fixes for these issue IDs: ${input.automaticPullRequestIssueIds.join(", ")}. Do not modify code in this investigation.`
        : "The report was saved.",
    ...(input.slackMarkdown !== undefined
      ? { slackMarkdown: input.slackMarkdown }
      : {}),
  };
}

export async function deliverCompletedInvestigationWithWarnings(
  investigationId: string,
): Promise<string[]> {
  try {
    return await deliverInvestigationToSlack(investigationId);
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
  report: InvestigationReportSubmission;
  environment?: NodeJS.ProcessEnv;
  onAutomaticPullRequestRequests?: (requestIds: string[]) => Promise<void>;
}) {
  const newIssues = input.report.issues.filter(
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
      report: input.report,
      newIssueEmbeddings,
    },
  });
  await input.onAutomaticPullRequestRequests?.(
    result.automaticPullRequestRequestIds,
  );
  return reportToolResult({
    issueIds: result.issues.map((issue) => issue.id),
    automaticPullRequestIssueIds: result.automaticPullRequestIssueIds,
    slackMarkdown: result.markdown,
  });
}

export function createSubmitInvestigationReportTool(input: {
  investigationId: string;
  organizationId: string;
  environment?: NodeJS.ProcessEnv;
  onAutomaticPullRequestRequests?: (requestIds: string[]) => Promise<void>;
}) {
  return tool({
    name: "submit_investigation_report",
    description: submitInvestigationReportDescription,
    parameters: investigationReportSubmissionSchema,
    async execute(report) {
      return submitInvestigationReportForRun({
        investigationId: input.investigationId,
        organizationId: input.organizationId,
        report,
        environment: input.environment,
        onAutomaticPullRequestRequests:
          input.onAutomaticPullRequestRequests,
      });
    },
  });
}

export function createCaptureInvestigationReplayReportTool(input: {
  investigationId: string;
  organizationId: string;
}) {
  return tool({
    name: "submit_investigation_report",
    description: submitInvestigationReportDescription,
    parameters: investigationReportSubmissionSchema,
    async execute(report) {
      return captureInvestigationReplayReport({ ...input, report });
    },
  });
}

export async function captureInvestigationReplayReport(input: {
  investigationId: string;
  organizationId: string;
  report: InvestigationReportSubmission;
}) {
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
    automaticPullRequestIssueIds: [],
    issueIds: input.report.issues
      .filter((issue) => issue.resolution === "existing")
      .map((issue) => issue.issueId),
  });
}
