import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  createSyntheticCheck,
  deleteSyntheticCheck,
  findSyntheticCheck,
  listSyntheticChecks,
  updateSyntheticCheck,
  type SyntheticCheck,
  type SyntheticSlackTarget,
} from "../../../../packages/core/src/db/synthetic-checks.js";
import { listTelemetryAlertSlackChannels } from "../../../../packages/core/src/db/telemetry-alerts.js";
import { responderSyntheticCheckUrl } from "../../../../packages/core/src/responder-urls.js";
import { syntheticCheckInputSchema, type SyntheticCheckInput } from "../../../../packages/core/src/synthetics/schema.js";
import {
  syntheticAssertionKinds,
  syntheticAssertionOps,
  syntheticIntervals,
  syntheticMethods,
} from "../../../../packages/core/src/synthetics/types.js";
import { controlPlaneBaseUrl } from "../integrations/urls.js";
import { defineOperation, ManagementError, type ManagementContext } from "./operation.js";

// Synthetic checks, as the Synthetics page shows them: HTTP requests the
// worker makes on a schedule. They come with alerts, so they need the alerts
// feature.

const checkId = z.uuid().describe("Synthetic check ID.");

const assertion = z.object({
  key: z.string().max(500).optional().describe("The header name for `header`, or the JSON path for `json_path`, such as `$.status`."),
  kind: z
    .enum(syntheticAssertionKinds)
    .describe("What the assertion reads: the status code, response time in ms, a header, the body text, a JSON path, or days until the TLS certificate expires."),
  op: z
    .enum(syntheticAssertionOps)
    .describe("`status_code` takes eq, neq, lt, gt; `response_time` lt; `header` eq, neq, contains, not_contains, exists, not_exists; `body` contains, not_contains; `json_path` all; `certificate_expiry` gt."),
  severity: z.enum(["critical", "degraded"]).optional().describe("A failed `critical` assertion fails the run; a `degraded` one marks it degraded. Defaults to `critical`."),
  value: z.string().max(1_000).optional().describe("Compared with the response. A status code may be a class such as `2xx`."),
});

const header = z.object({
  name: z.string().max(200),
  secret: z.boolean().optional().describe("Stores the value encrypted and never returns it. Defaults to false."),
  value: z
    .string()
    .max(8_192)
    .nullable()
    .describe("The header value. For a secret header, null keeps the saved value while the URL keeps its host. MCP clients can only send null for a secret."),
});

const fields = {
  assertions: z.array(assertion).max(20).describe("Checks on the response. Without any, a run passes when the request completes."),
  body: z.string().max(65_536).nullable().describe("The request body. Not for GET or HEAD."),
  enabled: z.boolean().describe("A disabled check does not run."),
  failuresToAlert: z.number().int().min(1).max(10).describe("Failed runs in a row before the check posts to Slack."),
  followRedirects: z.boolean(),
  headers: z.array(header).max(30).describe("Request headers. The list replaces the saved headers."),
  intervalSeconds: z
    .number()
    .int()
    .describe(`How often the check runs: one of ${syntheticIntervals.join(", ")} seconds.`),
  method: z.enum(syntheticMethods),
  name: z.string().max(200),
  retries: z.number().int().min(0).max(2).describe("Immediate retries before a run counts as failed."),
  slack: z
    .object({
      channelId: z.string().max(64).describe("The Slack channel ID: the `channelId` of a channel alerts can post to."),
      integrationAccountId: z.uuid().describe("The ID of the Slack integration the channel belongs to."),
    })
    .nullable()
    .describe("Where failures and recoveries are posted. Without a channel the check only records its runs."),
  timeoutMs: z.number().int().min(1_000).max(30_000),
  url: z.string().max(2_048).describe("The full HTTP or HTTPS URL to request."),
};

const defaults = "Defaults: GET, every 300 seconds, a 10 second timeout, 1 retry, alert after 1 failure, follow redirects, enabled.";

const checkSchema = z.object({
  assertions: z.array(
    z.object({
      key: z.string().optional(),
      kind: z.enum(syntheticAssertionKinds),
      op: z.enum(syntheticAssertionOps),
      severity: z.enum(["critical", "degraded"]),
      value: z.string(),
    }),
  ),
  body: z.string().nullable(),
  createdAt: z.string(),
  enabled: z.boolean(),
  failuresToAlert: z.number().int(),
  followRedirects: z.boolean(),
  headers: z
    .array(z.object({ name: z.string(), secret: z.boolean(), value: z.string() }))
    .describe("A secret header's value is always empty."),
  id: checkId,
  intervalSeconds: z.number().int(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.enum(["passed", "degraded", "failed"]).nullable(),
  method: z.enum(syntheticMethods),
  name: z.string(),
  retries: z.number().int(),
  slack: z.object({ channelId: z.string(), integrationAccountId: z.string() }).nullable(),
  statusSince: z.string().nullable().describe("When the check reached its last status."),
  timeoutMs: z.number().int(),
  updatedAt: z.string(),
  url: z.string(),
  webUrl: z.url().describe("The check in Superlog."),
});

function withUrl<Check extends SyntheticCheck>(check: Check): Check & { webUrl: string } {
  return { ...check, webUrl: responderSyntheticCheckUrl(check.id, controlPlaneBaseUrl()) };
}

const checkNotFound = () => new ManagementError(404, "Synthetic check not found", "synthetic_check_not_found");

async function requireSynthetics(context: ManagementContext): Promise<void> {
  if (!(await organizationHasCapability(context.organizationId, "alerts"))) {
    throw new ManagementError(404, "Synthetic checks are not available in this workspace.", "synthetics_unavailable");
  }
}

// Checks a whole check with the rules the editor applies. Secret header
// values stay out of MCP, so they do not pass through a model.
function parseCheck(context: ManagementContext, input: unknown): SyntheticCheckInput {
  const parsed = syntheticCheckInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ManagementError(400, "Invalid synthetic check", "invalid_request", parsed.error.issues);
  }
  if (context.source === "mcp" && parsed.data.headers.some((item) => item.secret && item.value)) {
    throw new ManagementError(
      400,
      "Set secret header values in Superlog or with the API, not through MCP.",
      "secret_header_value",
    );
  }
  return parsed.data;
}

// The channel must belong to one of the workspace's connected Slack
// workspaces, and the app must be in it when it is private.
async function checkSlack(context: ManagementContext, slack: SyntheticSlackTarget | null): Promise<void> {
  if (!slack) return;
  const channels = await listTelemetryAlertSlackChannels(context.organizationId);
  const found = channels.some(
    (channel) => channel.channelId === slack.channelId && channel.integrationAccountId === slack.integrationAccountId,
  );
  if (!found) {
    throw new ManagementError(
      400,
      "Choose a Slack channel from a connected workspace. For a private channel, invite the Superlog app first.",
      "slack_channel_unavailable",
    );
  }
}

// A saved check as editor input. Secret headers keep their saved values.
function savedInput(check: SyntheticCheck): Record<string, unknown> {
  return {
    assertions: check.assertions,
    body: check.body,
    enabled: check.enabled,
    failuresToAlert: check.failuresToAlert,
    followRedirects: check.followRedirects,
    headers: check.headers.map((item) => ({ ...item, value: item.secret ? null : item.value })),
    intervalSeconds: check.intervalSeconds,
    method: check.method,
    name: check.name,
    retries: check.retries,
    slack: check.slack,
    timeoutMs: check.timeoutMs,
    url: check.url,
  };
}

function sameSlack(a: SyntheticSlackTarget | null, b: SyntheticSlackTarget | null): boolean {
  return a?.channelId === b?.channelId && a?.integrationAccountId === b?.integrationAccountId;
}

export const syntheticOperations = [
  defineOperation({
    name: "list_synthetic_checks",
    summary: "List synthetic checks",
    description: "Lists the workspace's synthetic checks by name, with each one's request, assertions, last status, and uptime over the last day.",
    method: "GET",
    path: "/synthetic-checks",
    tag: "Synthetics",
    effect: "read",
    input: z.object({}),
    output: z.object({
      checks: z.array(
        checkSchema.extend({
          uptime: z.number().nullable().describe("The share of runs in the last day that did not fail, from 0 to 1."),
        }),
      ),
    }),
    async run(context) {
      await requireSynthetics(context);
      return { checks: (await listSyntheticChecks(context.organizationId)).map(withUrl) };
    },
  }),
  defineOperation({
    name: "get_synthetic_check",
    summary: "Get a synthetic check",
    description: "Returns a synthetic check. Secret header values are not returned.",
    method: "GET",
    path: "/synthetic-checks/{checkId}",
    tag: "Synthetics",
    effect: "read",
    input: z.object({ checkId }),
    output: z.object({ check: checkSchema }),
    async run(context, input) {
      await requireSynthetics(context);
      const check = await findSyntheticCheck(context.organizationId, input.checkId);
      if (!check) throw checkNotFound();
      return { check: withUrl(check) };
    },
  }),
  defineOperation({
    name: "create_synthetic_check",
    summary: "Create a synthetic check",
    description: `Creates a check that requests a URL on a schedule and checks the response. After \`failuresToAlert\` failed runs in a row it posts to its Slack channel, and posts the recovery in the same thread. ${defaults}`,
    method: "POST",
    path: "/synthetic-checks",
    tag: "Synthetics",
    effect: "write",
    successStatus: 201,
    input: z.object(fields).partial().required({ name: true, url: true }),
    output: z.object({ check: checkSchema }),
    async run(context, input) {
      await requireSynthetics(context);
      const check = parseCheck(context, input);
      await checkSlack(context, check.slack);
      const created = await createSyntheticCheck(context.organizationId, { ...check, createdBy: context.user.id });
      if ("error" in created) throw new ManagementError(created.status, created.error, "invalid_request");
      return { check: withUrl(created.check) };
    },
  }),
  defineOperation({
    name: "update_synthetic_check",
    summary: "Change a synthetic check",
    description:
      "Changes the fields you send and keeps the rest. `headers` and `assertions` each replace the whole list. Changing the request or assertions, or disabling the check, ends its open failure without posting a recovery.",
    method: "PATCH",
    path: "/synthetic-checks/{checkId}",
    tag: "Synthetics",
    effect: "destructive",
    input: z.object(fields).partial().extend({ checkId }),
    output: z.object({ check: checkSchema }),
    async run(context, input) {
      await requireSynthetics(context);
      const { checkId: id, ...changes } = input;
      const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      if (Object.keys(defined).length === 0) {
        throw new ManagementError(400, "Send at least one field to change.", "nothing_to_update");
      }
      const current = await findSyntheticCheck(context.organizationId, id);
      if (!current) throw checkNotFound();
      const check = parseCheck(context, { ...savedInput(current), ...defined });
      // A channel that has gone since the check was saved can stay, so other
      // changes still save.
      if (!sameSlack(current.slack, check.slack)) await checkSlack(context, check.slack);
      const updated = await updateSyntheticCheck(context.organizationId, id, check);
      if ("error" in updated) {
        throw updated.status === 404 ? checkNotFound() : new ManagementError(400, updated.error, "invalid_request");
      }
      return { check: withUrl(updated.check) };
    },
  }),
  defineOperation({
    name: "delete_synthetic_check",
    summary: "Delete a synthetic check",
    description: "Deletes a synthetic check and its run history.",
    method: "DELETE",
    path: "/synthetic-checks/{checkId}",
    tag: "Synthetics",
    effect: "destructive",
    input: z.object({ checkId }),
    output: z.object({ deleted: z.literal(true) }),
    async run(context, input) {
      await requireSynthetics(context);
      if (!(await deleteSyntheticCheck(context.organizationId, input.checkId))) throw checkNotFound();
      return { deleted: true as const };
    },
  }),
];
