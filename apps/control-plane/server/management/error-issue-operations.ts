import { z } from "zod";
import {
  errorIssueDays,
  findErrorIssue,
  listErrorIssues,
  setErrorIssueStatus,
  type ErrorIssue,
  type ErrorIssueSummary,
} from "../../../../packages/core/src/db/error-issues.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { responderErrorIssueUrl } from "../../../../packages/core/src/responder-urls.js";
import { errorIssueKinds, errorIssueStatuses } from "../../../../packages/core/src/telemetry/error-issues.js";
import { controlPlaneBaseUrl } from "../integrations/urls.js";
import { errorIssueDetailDays, firstDay } from "../telemetry/error-issue-routes.js";
import { defineOperation, ManagementError, type ManagementContext } from "./operation.js";

// The workspace's telemetry exceptions grouped into issues by fingerprint,
// as the Errors page shows them.

const issueId = z.uuid().describe("Error issue ID.");
const status = z.enum(errorIssueStatuses);

const summarySchema = z.object({
  eventCount: z.number().describe("Occurrences since the issue was first seen."),
  exceptionType: z.string(),
  firstSeenAt: z.string(),
  id: z.string(),
  kind: z.enum(errorIssueKinds).describe("Whether the first occurrence was a span exception event or an error log."),
  lastSeenAt: z.string(),
  regressedAt: z.string().nullable().describe("When the issue last occurred again after being resolved."),
  service: z.string().nullable(),
  status,
  statusChangedAt: z.string().nullable(),
  title: z.string(),
  topFrame: z.string().nullable().describe("The innermost application frame, as `function@path`."),
  url: z.string(),
});

const issueSchema = summarySchema.extend({
  days: z.array(z.object({ day: z.string(), eventCount: z.number() }))
    .describe("Occurrences per UTC day over the last 30 days. Days without occurrences are left out."),
  fingerprint: z.string(),
  frames: z.array(z.string()).describe("The application frames the issue is grouped by, innermost first."),
  lastSample: z.object({
    attributes: z.record(z.string(), z.string()),
    kind: z.enum(errorIssueKinds),
    message: z.string().nullable(),
    resourceAttributes: z.record(z.string(), z.string()),
    seenAt: z.string(),
    service: z.string().nullable(),
    severity: z.string().nullable(),
    spanId: z.string().nullable(),
    spanName: z.string().nullable(),
    stacktrace: z.string().nullable(),
    traceId: z.string().nullable(),
  }).describe("The newest occurrence. Follow its `traceId` with get_trace."),
  message: z.string().nullable(),
});

function withUrl<Issue extends ErrorIssueSummary>(issue: Issue): Issue & { url: string } {
  return { ...issue, url: responderErrorIssueUrl(issue.id, controlPlaneBaseUrl()) };
}

async function requireTelemetry(context: ManagementContext): Promise<void> {
  if (!(await organizationHasCapability(context.organizationId, "telemetry"))) {
    throw new ManagementError(404, "Telemetry is not available in this workspace.", "telemetry_unavailable");
  }
}

async function issueWithDays(context: ManagementContext, issue: ErrorIssue) {
  const days = await errorIssueDays([issue.id], firstDay(new Date(), errorIssueDetailDays));
  return { ...withUrl(issue), days: days.get(issue.id) ?? [] };
}

const issueNotFound = () => new ManagementError(404, "Error issue not found", "error_issue_not_found");

export const errorIssueOperations = [
  defineOperation({
    name: "list_error_issues",
    summary: "List error issues",
    description:
      "Lists the workspace's error issues, most recently seen first. Each issue groups exceptions with the same type, normalized message, and application frames.",
    method: "GET",
    path: "/error-issues",
    tag: "Errors",
    effect: "read",
    input: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25).describe("Most issues to return."),
      search: z.string().trim().min(1).max(200).optional().describe("Case-insensitive text in the title, top frame, or exception type."),
      service: z.string().trim().min(1).max(200).optional().describe("Only issues from this `service.name`."),
      status: z.enum([...errorIssueStatuses, "all"]).default("open").describe("Defaults to `open`."),
    }),
    output: z.object({ issues: z.array(summarySchema) }),
    async run(context, input) {
      await requireTelemetry(context);
      const issues = await listErrorIssues(context.organizationId, {
        limit: input.limit,
        ...(input.search ? { search: input.search } : {}),
        ...(input.service ? { service: input.service } : {}),
        ...(input.status === "all" ? {} : { status: input.status }),
      });
      return { issues: issues.map(withUrl) };
    },
  }),
  defineOperation({
    name: "get_error_issue",
    summary: "Get an error issue",
    description: "Returns an error issue with its newest occurrence, including the stack trace, and its occurrences per day.",
    method: "GET",
    path: "/error-issues/{issueId}",
    tag: "Errors",
    effect: "read",
    input: z.object({ issueId }),
    output: z.object({ issue: issueSchema }),
    async run(context, input) {
      await requireTelemetry(context);
      const issue = await findErrorIssue(context.organizationId, input.issueId);
      if (!issue) throw issueNotFound();
      return { issue: await issueWithDays(context, issue) };
    },
  }),
  defineOperation({
    name: "update_error_issue",
    summary: "Resolve, silence, or reopen an error issue",
    description:
      "Sets an error issue's status. A resolved issue opens again when it occurs after being resolved; a silenced issue only counts its occurrences.",
    method: "PATCH",
    path: "/error-issues/{issueId}",
    tag: "Errors",
    effect: "write",
    input: z.object({ issueId, status }),
    output: z.object({ issue: issueSchema }),
    async run(context, input) {
      await requireTelemetry(context);
      const issue = await setErrorIssueStatus(context.organizationId, input.issueId, input.status);
      if (!issue) throw issueNotFound();
      return { issue: await issueWithDays(context, issue) };
    },
  }),
];
