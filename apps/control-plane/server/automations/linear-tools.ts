import { z } from "zod";
import type { AutomationContextBrokerClaim } from "../../../../packages/core/src/db/automation-model-broker.js";
import {
  appendAutomationRunEvent,
  beginAutomationActionAttempt,
  completeAutomationActionAttempt,
  failAutomationActionAttempt,
} from "../../../../packages/core/src/db/automations.js";
import {
  callLinearReadOnlyTool,
  createLinearIssue,
  findLinearIssueById,
  listLinearReadOnlyTools,
} from "../../../../packages/core/src/integrations/linear.js";
import { recordedWrite, type RecordedWriteDependencies } from "./recorded-write.js";

// Linear tools for automation runs. Reads come from Linear's read-only MCP
// endpoint. The only write is create_issue, which the broker makes itself and
// records as an action of the run.

export interface LinearToolDependencies extends RecordedWriteDependencies {
  callTool: typeof callLinearReadOnlyTool;
  createIssue: typeof createLinearIssue;
  findIssue: typeof findLinearIssueById;
  listTools: typeof listLinearReadOnlyTools;
}

export const defaultLinearToolDependencies: LinearToolDependencies = {
  appendEvent: appendAutomationRunEvent,
  beginAttempt: beginAutomationActionAttempt,
  callTool: callLinearReadOnlyTool,
  completeAttempt: completeAutomationActionAttempt,
  createIssue: createLinearIssue,
  failAttempt: failAutomationActionAttempt,
  findIssue: findLinearIssueById,
  listTools: listLinearReadOnlyTools,
};

export const linearCreateIssueToolName = "create_issue";

const linearId = z.string().trim().min(1).max(100);
const createIssueInput = z.object({
  assignee_id: linearId.optional(),
  description: z.string().trim().min(1).max(50_000),
  label_ids: z.array(linearId).max(20).optional(),
  parent_id: linearId.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  project_id: linearId.optional(),
  state_id: linearId.optional(),
  team_id: linearId,
  title: z.string().trim().min(1).max(255),
});

const idProperty = (description: string) => ({
  description,
  maxLength: 100,
  minLength: 1,
  type: "string",
});

export const linearCreateIssueToolDefinition = {
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description: "Create a Linear issue as the connected Linear workspace. Before creating, use the read tools to follow the team's conventions: read recent issues for title style, labels, and priority, and choose the team, project, and workflow state that fit. To assign someone, look up Linear users and pass their ID; to find who wrote a change, use the GitHub tools. Returns the issue identifier and URL. Calling again with the same team and title in this run returns the issue already created.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      assignee_id: idProperty("The Linear user ID of the assignee."),
      description: { description: "The issue description in Markdown.", maxLength: 50_000, minLength: 1, type: "string" },
      label_ids: { items: idProperty("A Linear label ID."), maxItems: 20, type: "array" },
      parent_id: idProperty("The Linear issue ID of the parent issue."),
      priority: { description: "0 none, 1 urgent, 2 high, 3 medium, 4 low.", maximum: 4, minimum: 0, type: "integer" },
      project_id: idProperty("The Linear project ID."),
      state_id: idProperty("The Linear workflow state ID. Defaults to the team's default state."),
      team_id: idProperty("The Linear team ID."),
      title: { maxLength: 255, minLength: 1, type: "string" },
    },
    required: ["team_id", "title", "description"],
    type: "object",
  },
  name: linearCreateIssueToolName,
};

export type LinearToolResult = {
  content: Array<{ text: string; type: "text" }>;
  isError?: true;
};

function success(value: unknown): LinearToolResult {
  return { content: [{ text: JSON.stringify(value), type: "text" }] };
}

function failure(message: string): LinearToolResult {
  return { content: [{ text: message, type: "text" }], isError: true };
}

// Linear issue URLs are https://linear.app/<workspace>/issue/<identifier>/<slug>.
export function linearIdentifierFromUrl(url: string): string | null {
  return /\/issue\/([A-Za-z0-9]+-\d+)(?:\/|$)/u.exec(url)?.[1] ?? null;
}

// The upstream read-only tools, then create_issue. A read tool that Linear
// does not mark read-only is left out.
export async function linearToolDefinitions(
  accessToken: string,
  dependencies: LinearToolDependencies,
) {
  const tools = await dependencies.listTools({ accessToken });
  return [
    ...tools.filter((tool) =>
      tool.name !== linearCreateIssueToolName && tool.annotations?.readOnlyHint !== false
    ),
    linearCreateIssueToolDefinition,
  ];
}

async function createIssue(
  claim: AutomationContextBrokerClaim,
  accessToken: string,
  args: unknown,
  dependencies: LinearToolDependencies,
): Promise<LinearToolResult> {
  const parsed = createIssueInput.safeParse(args);
  if (!parsed.success) return failure("Invalid tool arguments");
  const input = parsed.data;
  const result = await recordedWrite({
    claim,
    dependencies,
    eventData: { title: input.title },
    identity: [input.team_id, input.title],
    kind: "create_linear_issue",
    redactedInput: {
      teamId: input.team_id,
      title: input.title,
      ...(input.assignee_id ? { assigneeId: input.assignee_id } : {}),
      ...(input.project_id ? { projectId: input.project_id } : {}),
    },
    toolName: linearCreateIssueToolName,
    // The attempt ID becomes the Linear issue ID, so a retry after an
    // uncertain failure finds the issue instead of creating a second one.
    write: async (attemptId) => {
      let created;
      try {
        created = await dependencies.createIssue({
          accessToken,
          assigneeId: input.assignee_id,
          description: input.description,
          id: attemptId,
          labelIds: input.label_ids,
          parentId: input.parent_id,
          priority: input.priority,
          projectId: input.project_id,
          stateId: input.state_id,
          teamId: input.team_id,
          title: input.title,
        });
      } catch (creationError) {
        created = await dependencies.findIssue({ accessToken, issueId: attemptId })
          .catch(() => null);
        if (!created) throw creationError;
      }
      return created.url;
    },
  });
  const url = result.externalReference;
  return success({
    identifier: url ? linearIdentifierFromUrl(url) : null,
    url,
    ...(result.repeated ? { note: "This issue was already created in this run." } : {}),
  });
}

// Linear API errors go back to the agent as tool errors so it can adjust.
export async function callLinearTool(input: {
  accessToken: string;
  args: unknown;
  claim: AutomationContextBrokerClaim;
  dependencies: LinearToolDependencies;
  name: string;
}): Promise<LinearToolResult | Awaited<ReturnType<LinearToolDependencies["callTool"]>>> {
  if (input.name !== linearCreateIssueToolName) {
    const args = z.record(z.string(), z.unknown()).safeParse(input.args ?? {});
    if (!args.success) return failure("Invalid tool arguments");
    try {
      return await input.dependencies.callTool({
        accessToken: input.accessToken,
        arguments: args.data,
        name: input.name,
      });
    } catch (error) {
      return failure(`Linear ${input.name} failed: ${error instanceof Error ? error.message.slice(0, 500) : "request failed"}`);
    }
  }
  try {
    return await createIssue(input.claim, input.accessToken, input.args, input.dependencies);
  } catch (error) {
    if (error instanceof Error && error.message === "Automation action has an unresolved prior attempt") {
      return failure("The same Linear issue is still being created.");
    }
    return failure(`Linear did not create the issue: ${error instanceof Error ? error.message.slice(0, 500) : "request failed"}`);
  }
}
