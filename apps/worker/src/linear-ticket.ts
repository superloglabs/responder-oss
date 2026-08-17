import { tool } from "@openai/agents";
import { fulfillLinearTicketRequest } from "@responder/core/db/linear-tickets";
import { z } from "zod";

export function createLinearTicketTool(input: {
  agentConfigVersionId: string;
  investigationId: string;
  organizationId: string;
  requestId: string;
}) {
  return tool({
    name: "create_linear_ticket",
    description:
      "Create the Linear issue for a pending request returned by submit_investigation_report. Use Linear read tools first to choose the team and project. This tool applies the saved template and records the Linear identifier and link.",
    parameters: z.object({
      teamId: z.string().min(1),
      projectId: z.string().min(1).optional(),
    }),
    async execute(selection) {
      const issue = await fulfillLinearTicketRequest({
        ...selection,
        ...input,
      });
      return {
        created: true,
        linearIssueId: issue.id,
        linearIdentifier: issue.identifier,
        linearIssueUrl: issue.url,
      };
    },
  });
}
