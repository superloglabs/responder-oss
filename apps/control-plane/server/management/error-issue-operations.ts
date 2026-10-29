import { z } from "zod";
import {
  claimErrorIssue,
  errorIssueActivity,
  errorIssueDays,
  findErrorIssue,
  listErrorIssues,
  postErrorIssueUpdate,
  releaseErrorIssue,
  setErrorIssueStatus,
  type ErrorIssue,
  type ErrorIssueClaimant,
  type ErrorIssueClaimResult,
  type ErrorIssueSummary,
} from "../../../../packages/core/src/db/error-issues.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { responderErrorIssueUrl } from "../../../../packages/core/src/responder-urls.js";
import {
  type ErrorIssueClaim,
  errorIssueActivityTypes,
  errorIssueActorName,
  errorIssueKinds,
  errorIssueStatuses,
} from "../../../../packages/core/src/telemetry/error-issues.js";
import { controlPlaneBaseUrl } from "../integrations/urls.js";
import { errorIssueDetailDays, firstDay } from "../telemetry/error-issue-routes.js";
import { defineOperation, ManagementError, type ManagementContext } from "./operation.js";

// The workspace's telemetry exceptions grouped into issues by fingerprint,
// as the Errors page shows them.

const issueId = z.uuid().describe("Error issue ID.");
const status = z.enum(errorIssueStatuses);
const agent = z.string().trim().min(1).max(100).optional()
  .describe("A name for yourself, such as `Claude Code in api-fix`, so agents acting for the same member can tell their claims apart. Pass the same name on every call about an issue.");
const message = z.string().trim().min(1).max(4000);

const actorSchema = z.object({
  agent: z.string().nullable(),
  client: z.string().nullable().describe("The MCP client or API key the change came through. Changes made in the app have none."),
  user: z.object({ id: z.string(), name: z.string() })
    .describe("The member the change was made for. For a change made from a Slack notification, the Slack user, with their Slack user ID."),
});
const claimSchema = actorSchema.extend({ claimedAt: z.string() }).nullable()
  .describe("Who is working on the issue. Resolving or silencing the issue ends the claim.");

const summarySchema = z.object({
  claim: claimSchema,
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
  activity: z.array(z.object({
    actor: actorSchema,
    createdAt: z.string(),
    id: z.string(),
    message: z.string().nullable(),
    pullRequestUrl: z.string().nullable(),
    status: status.nullable().describe("The status a status change set."),
    type: z.enum(errorIssueActivityTypes),
  })).describe("Claims, updates, and status changes, oldest first. Up to the newest 100."),
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
  pullRequests: z.array(z.object({ linkedAt: z.string(), url: z.string() })).describe("Pull requests linked by updates."),
});

function withUrl<Issue extends ErrorIssueSummary>(issue: Issue): Issue & { url: string } {
  return { ...issue, url: responderErrorIssueUrl(issue.id, controlPlaneBaseUrl()) };
}

async function requireTelemetry(context: ManagementContext): Promise<void> {
  if (!(await organizationHasCapability(context.organizationId, "telemetry"))) {
    throw new ManagementError(404, "Telemetry is not available in this workspace.", "telemetry_unavailable");
  }
}

async function issueDetail(issue: ErrorIssue) {
  const [days, activity] = await Promise.all([
    errorIssueDays([issue.id], firstDay(new Date(), errorIssueDetailDays)),
    errorIssueActivity(issue.id),
  ]);
  return { ...withUrl(issue), ...activity, days: days.get(issue.id) ?? [] };
}

const issueNotFound = () => new ManagementError(404, "Error issue not found", "error_issue_not_found");

// The caller as an issue's claimant: the member, the API key or MCP client
// they called through, and the agent's name for itself.
function claimant(context: ManagementContext, agentName: string | undefined): ErrorIssueClaimant {
  return {
    actor: {
      agent: agentName ?? null,
      client: context.clientName,
      user: { id: context.user.id, name: context.user.name },
    },
    credential: context.oauthClientId ? `oauth:${context.oauthClientId}` : `api_key:${context.apiKeyId}`,
  };
}

const claimedByOther = (claim: ErrorIssueClaim, hint: string) => new ManagementError(
  409,
  `${errorIssueActorName(claim)} claimed this issue at ${claim.claimedAt}. ${hint}`,
  "error_issue_claimed",
);

async function claimedIssue(result: ErrorIssueClaimResult | null, hint: string) {
  if (!result) throw issueNotFound();
  if (!result.ok) throw claimedByOther(result.claim, hint);
  return { issue: await issueDetail(result.issue) };
}

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
      claim: z.enum(["any", "claimed", "unclaimed"]).default("any")
        .describe("`unclaimed` leaves out issues an agent or member is already working on."),
    }),
    output: z.object({ issues: z.array(summarySchema) }),
    async run(context, input) {
      await requireTelemetry(context);
      const issues = await listErrorIssues(context.organizationId, {
        limit: input.limit,
        ...(input.search ? { search: input.search } : {}),
        ...(input.service ? { service: input.service } : {}),
        ...(input.status === "all" ? {} : { status: input.status }),
        ...(input.claim === "any" ? {} : { claimed: input.claim === "claimed" }),
      });
      return { issues: issues.map(withUrl) };
    },
  }),
  defineOperation({
    name: "get_error_issue",
    summary: "Get an error issue",
    description: "Returns an error issue with its newest occurrence, including the stack trace, its occurrences per day, who has claimed it, its updates, and its linked pull requests.",
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
      return { issue: await issueDetail(issue) };
    },
  }),
  defineOperation({
    name: "update_error_issue",
    summary: "Resolve, silence, or reopen an error issue",
    description:
      "Sets an error issue's status. A resolved issue opens again when it occurs after being resolved; a silenced issue only counts its occurrences. Resolving or silencing an issue ends its claim. Say why in `message`, such as the fix and where it shipped.",
    method: "PATCH",
    path: "/error-issues/{issueId}",
    tag: "Errors",
    effect: "write",
    input: z.object({
      agent,
      issueId,
      message: message.optional().describe("Why the status changed. Shown on the issue."),
      status,
    }),
    output: z.object({ issue: issueSchema }),
    async run(context, input) {
      await requireTelemetry(context);
      const issue = await setErrorIssueStatus(context.organizationId, input.issueId, input.status, {
        actor: claimant(context, input.agent).actor,
        ...(input.message ? { message: input.message } : {}),
      });
      if (!issue) throw issueNotFound();
      return { issue: await issueDetail(issue) };
    },
  }),
  defineOperation({
    name: "claim_error_issue",
    summary: "Claim an error issue",
    description:
      "Marks an error issue as one you are working on, so other agents and members can see it and leave it to you. Fails with `error_issue_claimed` when someone else holds it; pass `takeOver` only when the person asks or the claim is clearly abandoned. Claiming an issue you already hold changes nothing. Resolving or silencing the issue, or releasing it, ends the claim.",
    method: "POST",
    path: "/error-issues/{issueId}/claim",
    tag: "Errors",
    effect: "write",
    input: z.object({
      agent,
      issueId,
      message: message.optional().describe("What you are going to do. Shown on the issue."),
      takeOver: z.boolean().default(false).describe("Take the issue from whoever holds it."),
    }),
    output: z.object({ issue: issueSchema }),
    async run(context, input) {
      await requireTelemetry(context);
      return claimedIssue(
        await claimErrorIssue(context.organizationId, input.issueId, claimant(context, input.agent), {
          ...(input.message ? { message: input.message } : {}),
          takeOver: input.takeOver,
        }),
        "Pick another issue, or pass `takeOver` if the person asks you to take it.",
      );
    },
  }),
  defineOperation({
    name: "release_error_issue",
    summary: "Release an error issue",
    description:
      "Ends your claim on an error issue without changing its status, such as when you stop working on it. Releasing an unclaimed issue changes nothing. Fails with `error_issue_claimed` when someone else holds it.",
    method: "POST",
    path: "/error-issues/{issueId}/release",
    tag: "Errors",
    effect: "write",
    input: z.object({
      agent,
      issueId,
      message: message.optional().describe("Why you stopped, and what is left. Shown on the issue."),
    }),
    output: z.object({ issue: issueSchema }),
    async run(context, input) {
      await requireTelemetry(context);
      const holder = claimant(context, input.agent);
      return claimedIssue(
        await releaseErrorIssue(context.organizationId, input.issueId, holder.actor, {
          holder,
          ...(input.message ? { message: input.message } : {}),
        }),
        "Only the claimant can release it.",
      );
    },
  }),
  defineOperation({
    name: "post_error_issue_update",
    summary: "Post an update on an error issue",
    description:
      "Adds a progress update to an error issue, such as the root cause you found or the fix you are making. Pass `pullRequestUrl` to link the pull request with the fix; linked pull requests are listed on the issue.",
    method: "POST",
    path: "/error-issues/{issueId}/updates",
    tag: "Errors",
    effect: "write",
    input: z.object({
      agent,
      issueId,
      message: message.describe("The update, in Markdown."),
      pullRequestUrl: z.url({ protocol: /^https$/u }).max(2000).optional()
        .describe("The pull request or merge request this update links."),
    }),
    output: z.object({ issue: issueSchema }),
    successStatus: 201,
    async run(context, input) {
      await requireTelemetry(context);
      const issue = await postErrorIssueUpdate(context.organizationId, input.issueId, claimant(context, input.agent).actor, {
        message: input.message,
        ...(input.pullRequestUrl ? { pullRequestUrl: input.pullRequestUrl } : {}),
      });
      if (!issue) throw issueNotFound();
      return { issue: await issueDetail(issue) };
    },
  }),
];
