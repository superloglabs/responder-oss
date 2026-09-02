import { tool } from "@openai/agents";
import {
  updateIssueRemediations,
} from "@responder/core/db/issues";
import {
  authoredIssueRemediationsSchema,
} from "@responder/core/investigations/report";
import { z } from "zod";

export function createIssueRemediationUpdateTool(input: {
  allowedIssueIds: ReadonlySet<string>;
  onUpdated: (issueId: string) => void;
  organizationId: string;
}) {
  return tool({
    name: "update_issue_remediation",
    description:
      "Replace the proposed remediation options for an existing issue after follow-up feedback. Only update an issue when the new evidence changes its remediation; do not create issues or pull requests.",
    parameters: z.object({
      issueId: z.uuid(),
      remediations: authoredIssueRemediationsSchema,
    }),
    async execute(request) {
      if (!input.allowedIssueIds.has(request.issueId)) {
        throw new Error("The issue is not part of this Slack investigation thread");
      }
      const updated = await updateIssueRemediations({
        issueId: request.issueId,
        organizationId: input.organizationId,
        remediations: request.remediations,
      });
      if (!updated) throw new Error("Issue is unavailable for remediation update");
      input.onUpdated(updated.id);
      return {
        issueId: updated.id,
        remediation: updated.remediation,
        remediations: updated.remediations,
        updated: true,
      };
    },
  });
}
