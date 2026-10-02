import { renderInvestigationPromptPart, type InvestigationPromptParts } from "@responder/core/investigations/prompt-parts";
import {
  run,
  setDefaultOpenAIKey,
  setTracingDisabled,
  type Usage,
} from "@openai/agents";
import { Capabilities, SandboxAgent, skills } from "@openai/agents/sandbox";
import {
  DaytonaSandboxClient,
  type DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import {
  getRuntimeAwsConnections,
  getRuntimeGcpConnections,
  getRuntimeAxiomConnection,
  getRuntimeCustomMcpConnections,
  getRuntimeDatadogConnection,
  getRuntimeDash0Connections,
  getRuntimePostHogConnections,
  getRuntimeGrafanaConnections,
  getRuntimeClickStackConnection,
  getRuntimeLinearConnection,
  getRuntimeLangfuseConnections,
  getRuntimeSlackConnection,
  getRuntimeSentryConnection,
  getRuntimeSupabaseConnections,
  getRuntimeUpstashConnection,
  getRuntimeVercelConnections,
  getSlackInvestigationSessionRuntime,
  SentryConnectionUnavailableError,
  type RuntimeAxiomConnection,
  type RuntimeSentryConnection,
} from "@responder/core/db/investigations";
import { getRuntimeWorkspaceSecrets } from "@responder/core/db/workspace-secrets";
import { getRuntimeProfile } from "@responder/core/db/runtime-profiles";
import {
  daytonaClientOptions,
  requireDaytonaClientConfig,
  type DaytonaClientConfig,
} from "@responder/core/daytona-config";
import type {
  InvestigationInput,
  InvestigationTraceEvent,
} from "@responder/core/db/schema";
import type {
  InvestigationJob,
  SlackThreadInvestigationJob,
} from "@responder/core/jobs";
import { investigationPrompt, toInvestigationInput } from "@responder/core/investigations/input";
import { supabaseMcpUrl } from "@responder/core/integrations/supabase";
import { isSlackAssistantRequest } from "@responder/core/integrations/slack-assistant";
import { customTagModeInstructions } from "@responder/core/agents/config";
import { getSlackThreadModeActor } from "@responder/core/db/agents";
import { organizationHasCapability } from "@responder/core/db/organization-capabilities";
import {
  createAwsMcpServer,
  loadAwsAlarmSkillContext,
} from "./aws.js";
import { createAwsInspectionTools } from "./aws-inspection-tools.js";
import { createGcpMcpServers } from "./gcp.js";
import { createAxiomMcpServer } from "./axiom.js";
import { createDatadogMcpServer } from "./datadog.js";
import { createDash0McpServer } from "./dash0.js";
import { createPostHogMcpServer } from "./posthog.js";
import { createGrafanaMcpServer } from "./grafana.js";
import { createCustomMcpServer, createLinearMcpServer } from "./custom-mcp.js";
import { RecoverableMcpServer } from "./recoverable-mcp.js";
import { createClickStackMcpServer } from "./clickstack.js";
import { createLangfuseMcpServer } from "./langfuse.js";
import { createSearchExistingIssuesTool } from "./issue-search.js";
import {
  checkoutRuntimeRepositories,
  loadCheckedOutRepositories,
  refreshRuntimeRepositories,
  type CheckedOutRepository,
} from "./repositories.js";
import {
  discoverRepositoryInstructions,
  loadRepositorySkills,
} from "./repository-skills.js";
import { createRepositoryInspectionTools } from "./repository-inspection.js";
import {
  createCaptureInvestigationReplayReportTool,
  createSubmitInvestigationReportTool,
} from "./report.js";
import {
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  createDaytonaSandboxSession,
  prepareDaytonaSandbox,
  pauseDaytonaSandbox,
} from "./sandbox.js";
import { startSandboxMeter, type SandboxMeter } from "./sandbox-metering.js";
import { agentUsageIsBillable, recordAgentRunUsage } from "./agent-usage.js";
import {
  investigationTraceEventFromStream,
  traceEvent,
} from "./trace.js";
import { createSentryMcpServer } from "./sentry.js";
import { createSlackSearchServer } from "./slack.js";
import { createSupabaseMcpServer } from "./supabase.js";
import {
  createUpstashCliTools,
  createUpstashMcpServer,
} from "./upstash.js";
import {
  connectionSecrets,
  redactDaytonaSecretPlaceholders,
  redactSecrets,
  workspaceSecretUsageInstructions,
} from "./secret-safety.js";
import { createVercelTools } from "./vercel.js";
import { createThreadPullRequestTool } from "./thread-pull-request.js";
import { createWorkspaceTools } from "./workspace-tools.js";
import { createIssueRemediationUpdateTool } from "./issue-followup.js";
import {
  createSearchSuggestionsTool,
  createSuggestionTool,
} from "./suggestion-tools.js";

export interface SandboxAgentConfig extends DaytonaClientConfig {
  model: string;
  openAiApiKey: string;
}

export function safeInvestigationError(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  secrets: readonly string[] = [],
): string {
  let message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Investigation agent failed";
  for (const name of [
    "OPENAI_API_KEY",
    "DAYTONA_API_KEY",
    "AI_GATEWAY_API_KEY",
  ] as const) {
    const value = environment[name];
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  // Redact before truncating so a secret cut at the limit cannot leak a prefix.
  return redactDaytonaSecretPlaceholders(redactSecrets(message, secrets))
    .slice(0, 2_000);
}

export function investigationTraceWriteFailure(
  input: {
    error: unknown;
    investigationId: string;
    jobId: string;
    traceEventType: string;
  },
  environment: NodeJS.ProcessEnv = process.env,
) {
  return {
    error: safeInvestigationError(input.error, environment),
    event: "investigation_trace_write_failed",
    investigationId: input.investigationId,
    jobId: input.jobId,
    traceEventType: input.traceEventType,
  };
}

const contextServerConnectRetryDelaysMs = [0, 1_000, 3_000] as const;

// Node's fetch reports DNS, TLS, and socket failures as this TypeError.
function isFetchNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch failed";
}

// A brief network failure while opening a context server otherwise fails the
// whole investigation.
export async function connectContextServer(
  server: { connect(): Promise<void> },
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<void> {
  for (const [index, delayMs] of contextServerConnectRetryDelaysMs.entries()) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      await server.connect();
      return;
    } catch (error) {
      if (
        !isFetchNetworkFailure(error) ||
        index === contextServerConnectRetryDelaysMs.length - 1
      ) {
        throw error;
      }
    }
  }
}

export function contextServerConnectFailureEvent(input: {
  awsConnections?: ReadonlyArray<{ accountId: string }>;
  gcpConnections?: ReadonlyArray<{ accountId: string }>;
  customMcpConnections: ReadonlyArray<{ accountId: string }>;
  dash0Connections?: ReadonlyArray<{ accountId: string }>;
  postHogConnections?: ReadonlyArray<{ accountId: string }>;
  grafanaConnections?: ReadonlyArray<{ accountId: string }>;
  langfuseConnections?: ReadonlyArray<{ accountId: string }>;
  supabaseConnections?: ReadonlyArray<{ accountId: string }>;
  /** Already redacted with {@link redactSecrets}. */
  error: string;
  investigationId: string;
  serverName: string;
  upstashConnection?: { accountId: string } | null;
}) {
  const accountId = input.serverName.startsWith("upstash-")
    ? input.upstashConnection?.accountId
    : input.serverName.startsWith("aws-")
      ? input.awsConnections?.find(
          (connection) => input.serverName === `aws-${connection.accountId}`,
        )?.accountId
      : input.serverName.startsWith("gcp-")
        ? input.gcpConnections?.find(
            (connection) => input.serverName.startsWith(`gcp-${connection.accountId}-`),
          )?.accountId
        : input.serverName.startsWith("dash0-")
          ? input.dash0Connections?.find(
              (connection) =>
                input.serverName === `dash0-${connection.accountId}`,
            )?.accountId
          : input.serverName.startsWith("posthog-")
            ? input.postHogConnections?.find(
                (connection) =>
                  input.serverName === `posthog-${connection.accountId}`,
              )?.accountId
          : input.serverName.startsWith("grafana-")
            ? input.grafanaConnections?.find(
                (connection) =>
                  input.serverName === `grafana-${connection.accountId}`,
              )?.accountId
          : input.serverName.startsWith("langfuse-")
            ? input.langfuseConnections?.find(
                (connection) =>
                  input.serverName === `langfuse-${connection.accountId}`,
              )?.accountId
            : input.serverName.startsWith("supabase-")
              ? input.supabaseConnections?.find(
                  (connection) =>
                    input.serverName === `supabase-${connection.accountId}`,
                )?.accountId
            : input.customMcpConnections.find(
                (connection) =>
                  input.serverName === `custom-mcp-${connection.accountId}`,
              )?.accountId;
  return {
    ...(accountId ? { accountId } : {}),
    error: input.error,
    event: "context_server_connect_failed",
    investigationId: input.investigationId,
    server: input.serverName,
  };
}

export async function loadSentryConnectionForInvestigation(input: {
  getConnection?: typeof getRuntimeSentryConnection;
  investigationId: string;
  investigationInput: InvestigationInput;
  onRecoverableFailure?: (
    error: SentryConnectionUnavailableError,
  ) => Promise<void>;
  versionId: string;
}): Promise<RuntimeSentryConnection | null> {
  const getConnection = input.getConnection ?? getRuntimeSentryConnection;
  try {
    const connection = await getConnection(
      input.versionId,
      input.investigationInput,
    );
    if (!connection && input.investigationInput.provider === "sentry") {
      console.info(
        JSON.stringify({
          event: "sentry_connection_unavailable",
          investigationId: input.investigationId,
        }),
      );
    }
    return connection;
  } catch (error) {
    if (!(error instanceof SentryConnectionUnavailableError)) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          errorCode: error instanceof Error ? error.name : typeof error,
          event: "sentry_connection_lookup_failed",
          investigationId: input.investigationId,
        }),
      );
      throw error;
    }

    console.error(
      JSON.stringify({
        errorCode: error.errorCode,
        event: "sentry_connection_degraded",
        failureKind: error.failureKind,
        ...(error.httpStatus === undefined
          ? {}
          : { httpStatus: error.httpStatus }),
        investigationContinues: true,
        investigationId: input.investigationId,
        requestDurationMs: error.requestDurationMs,
        retryable: error.retryable,
      }),
    );
    if (input.onRecoverableFailure) {
      try {
        await input.onRecoverableFailure(error);
      } catch (reportingError) {
        console.error(
          JSON.stringify({
            error:
              reportingError instanceof Error
                ? reportingError.message
                : String(reportingError),
            errorCode:
              reportingError instanceof Error
                ? reportingError.name
                : typeof reportingError,
            event: "sentry_connection_degraded_reporting_failed",
            investigationId: input.investigationId,
          }),
        );
      }
    }
    return null;
  }
}

export async function loadAxiomConnectionForInvestigation(input: {
  getConnection?: (versionId: string) => Promise<RuntimeAxiomConnection | null>;
  investigationId: string;
  versionId: string;
}): Promise<RuntimeAxiomConnection | null> {
  const getConnection = input.getConnection ?? getRuntimeAxiomConnection;
  try {
    return await getConnection(input.versionId);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("Reconnect custom MCP ")
    ) {
      throw error;
    }
    console.error(
      JSON.stringify({
        accountId: (error as Error & { accountId?: string }).accountId,
        event: "axiom_connection_degraded",
        investigationContinues: true,
        investigationId: input.investigationId,
      }),
    );
    return null;
  }
}

export function sandboxAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SandboxAgentConfig {
  const openAiApiKey = environment.OPENAI_API_KEY;
  if (!openAiApiKey) throw new Error("OPENAI_API_KEY is required");

  const daytonaConfig = requireDaytonaClientConfig(environment);

  return {
    ...daytonaConfig,
    model: environment.OPENAI_AGENT_MODEL ?? "gpt-5.6-sol",
    openAiApiKey,
  };
}

export function investigationCapabilities(replay: boolean) {
  void replay;
  return Capabilities.default();
}

export const investigationMaxTurns = 400;

// Where a Slack assistant sends people to connect integrations.
export function responderIntegrationsUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const origin = environment.RESPONDER_APP_URL ?? environment.BETTER_AUTH_URL;
  if (!origin) return "the Integrations page in Responder";
  try {
    return new URL("/settings", origin).toString();
  } catch {
    return "the Integrations page in Responder";
  }
}

// A paused Slack thread sandbox is deleted by Daytona this long after it stops.
export const pausedThreadSandboxLifetimeMinutes = 24 * 60;

export function investigationInstructions(input: {
  agentPrompt: string;
  awsAlarmTriggered?: boolean;
  awsAccountNames?: string[];
  awsSkillContext?: string;
  gcpProjectNames?: string[];
  customMcpNames?: string[];
  axiomConnected?: boolean;
  datadogConnected: boolean;
  dash0AccountNames?: string[];
  postHogAccountNames?: string[];
  grafanaInstanceNames?: string[];
  clickStackConnected: boolean;
  repositories: CheckedOutRepository[];
  repositoryInstructions?: string[];
  runtimeSystemPrompt?: string | null;
  runtimePromptParts?: InvestigationPromptParts;
  sentryConnected: boolean;
  sentryUnavailable?: boolean;
  linearConnected?: boolean;
  langfuseProjectNames?: string[];
  supabaseConnections?: Array<{
    accessMode: "logs" | "read_only" | "read_write";
    displayName: string;
  }>;
  slackChannels?: Array<{ id: string; name: string }>;
  upstashConnected?: boolean;
  workspaceSecrets?: Array<{
    environmentVariable: string;
    allowedHosts: string[];
  }>;
  vercelAccountIds?: string[];
  threadMode?: boolean;
  // A Slack thread in an organization with simplified navigation. It works
  // as a general assistant and is told about its pull request and workspace
  // tools.
  assistant?: { integrationsUrl: string; pullRequests: boolean };
  issueFollowupIssueCount?: number;
  scanMode?: boolean;
  replay?: boolean;
}): string {
  const prompt = (key: string, values: Record<string, string> = {}) =>
    renderInvestigationPromptPart(key, input.runtimePromptParts, values);
  const awsAccountNames = input.awsAccountNames ?? [];
  const customMcpNames = input.customMcpNames ?? [];
  const dash0AccountNames = input.dash0AccountNames ?? [];
  const postHogAccountNames = input.postHogAccountNames ?? [];
  const grafanaInstanceNames = input.grafanaInstanceNames ?? [];
  const gcpProjectNames = input.gcpProjectNames ?? [];
  const langfuseProjectNames = input.langfuseProjectNames ?? [];
  const supabaseConnections = input.supabaseConnections ?? [];
  const slackChannels = input.slackChannels ?? [];
  const workspaceSecrets = input.workspaceSecrets ?? [];
  const vercelAccountIds = input.vercelAccountIds ?? [];
  const repositoryInstructions = input.repositoryInstructions ?? [];
  const assistant = input.threadMode ? input.assistant : undefined;
  const issueUpdateFollowup = (input.issueFollowupIssueCount ?? 0) > 0;
  const noIssueFollowup = input.issueFollowupIssueCount === 0;
  const observabilityConnected =
    input.datadogConnected ||
    dash0AccountNames.length > 0 ||
    postHogAccountNames.length > 0 ||
    grafanaInstanceNames.length > 0 ||
    input.axiomConnected ||
    input.sentryConnected ||
    input.clickStackConnected ||
    input.upstashConnected ||
    langfuseProjectNames.length > 0 ||
    supabaseConnections.length > 0 ||
    vercelAccountIds.length > 0 ||
    awsAccountNames.length > 0 ||
    gcpProjectNames.length > 0 ||
    customMcpNames.length > 0;
  return [
    // The runtime system prompt describes incident investigations.
    assistant ? prompt("assistantScope") : input.runtimeSystemPrompt,
    input.agentPrompt,
    input.scanMode
      ? prompt("scanScope")
      : assistant
        ? null
        : prompt("investigationScope"),
    awsAccountNames.length > 0
      ? prompt("aws", { value1: awsAccountNames.join(", ") })
      : null,
    input.awsAlarmTriggered && awsAccountNames.length > 0
      ? prompt("awsAlarm")
      : null,
    input.awsSkillContext
      ? prompt("awsGuides", { value1: input.awsSkillContext })
      : null,
    awsAccountNames.length > 0
      ? prompt("awsTools")
      : null,
    gcpProjectNames.length > 0
      ? prompt("gcp", { value1: gcpProjectNames.join(", ") })
      : null,
    input.datadogConnected
      ? prompt("datadog")
      : null,
    dash0AccountNames.length > 0
      ? prompt("dash0", { value1: dash0AccountNames.join(", ") })
      : null,
    postHogAccountNames.length > 0
      ? prompt("posthog", { value1: postHogAccountNames.join(", ") })
      : null,
    grafanaInstanceNames.length > 0
      ? prompt("grafana", { value1: grafanaInstanceNames.join(", ") })
      : null,
    input.axiomConnected
      ? prompt("axiom")
      : null,
    input.clickStackConnected
      ? prompt("clickstack")
      : null,
    input.sentryConnected
      ? prompt("sentry")
      : null,
    input.sentryUnavailable
      ? prompt("sentryUnavailable")
      : null,
    input.upstashConnected
      ? prompt("upstash")
      : null,
    langfuseProjectNames.length > 0
      ? prompt("langfuse", { value1: langfuseProjectNames.join(", ") })
      : null,
    supabaseConnections.length > 0
      ? [
          prompt("supabase"),
          ...supabaseConnections.map((connection) => {
            if (connection.accessMode === "logs") {
              return prompt("supabaseLogs", { value1: connection.displayName });
            }
            if (connection.accessMode === "read_only") {
              return prompt("supabaseReadOnly", { value1: connection.displayName });
            }
            return prompt("supabaseReadWrite", { value1: connection.displayName });
          }),
        ].join("\n")
      : null,
    input.linearConnected
      ? prompt("linear")
      : null,
    vercelAccountIds.length > 0
      ? prompt("vercel", { value1: vercelAccountIds.join(", ") })
      : null,
    customMcpNames.length > 0
      ? prompt("customMcp", { value1: customMcpNames.join(", ") })
      : null,
    slackChannels.length > 0
      ? prompt("slack", { value1: slackChannels.map((channel) => `#${channel.name} (${channel.id})`).join(", ") })
      : null,
    !observabilityConnected
      ? prompt("noObservability")
      : null,
    input.repositories.length > 0
      ? [
          prompt("repositories"),
          ...input.repositories.map(
            (repository) =>
              prompt("repositoryEntry", { value1: repository.repository, value2: repository.path, value3: repository.branch, value4: repository.sha }),
          ),
          ...(assistant ? [] : [prompt("repositoryEvidence")]),
        ].join("\n")
      : assistant
        ? prompt("assistantNoRepositories")
        : prompt("noRepositories"),
    repositoryInstructions.length > 0
      ? [
          prompt("repositoryInstructions"),
          ...repositoryInstructions.map((path) => `- ${path}`),
        ].join("\n")
      : null,
    input.threadMode
      ? prompt(assistant ? "assistantSandbox" : "threadSandbox")
      : input.scanMode
        ? prompt("scanSandbox")
        : prompt("sandbox"),
    input.threadMode
      ? null
      : input.scanMode
        ? prompt("scanPermissions")
        : prompt("codePermissions"),
    prompt("credentialSafety"),
    workspaceSecretUsageInstructions(workspaceSecrets, input.runtimePromptParts),
    assistant
      ? assistant.pullRequests
        ? prompt("assistantPullRequests")
        : null
      : input.threadMode
        ? prompt("threadMode")
        : issueUpdateFollowup
          ? null
          : prompt("existingIssues"),
    assistant
      ? prompt("assistantWorkspace", { integrationsUrl: assistant.integrationsUrl })
      : null,
    !input.threadMode && !input.scanMode ? prompt("remediationChoice") : null,
    input.threadMode || input.replay || issueUpdateFollowup
      ? null
      : prompt("observabilitySuggestions"),
    issueUpdateFollowup
      ? prompt("issueFollowup")
      : noIssueFollowup
        ? prompt("noIssueFollowup")
        : null,
    input.threadMode || issueUpdateFollowup
      ? null
      : input.scanMode
        ? prompt("scanRemediations")
        : prompt("codeRemediations"),
    input.threadMode
      ? null
      : prompt("timeline"),
    input.threadMode
      ? prompt(assistant ? "assistantResponse" : "threadResponse")
      : issueUpdateFollowup
        ? prompt("followupResponse")
        : prompt("submitReport"),
    input.threadMode || issueUpdateFollowup
      ? null
      : prompt("reportResponse"),
    prompt(assistant ? "assistantUnverified" : "insufficientEvidence"),
  ]
    .filter((instruction): instruction is string => Boolean(instruction))
    .join("\n\n");
}

export function initialInvestigationMessage(
  input: InvestigationInput,
  at = new Date(),
): { message: string; traceEvent: InvestigationTraceEvent } {
  const message = investigationPrompt(input);
  return {
    message,
    traceEvent: traceEvent("message.received", { message }, at),
  };
}

export function investigationInstructionsTraceEvent(
  instructions: string,
  at = new Date(),
): InvestigationTraceEvent {
  return traceEvent("instructions.configured", { instructions }, at);
}

export async function runInvestigationAgent(
  job: InvestigationJob | SlackThreadInvestigationJob,
  environment: NodeJS.ProcessEnv = process.env,
  onTraceEvent: (event: InvestigationTraceEvent) => Promise<void>,
  traceContext: { jobId: string },
  onAutomaticPullRequestRequests?: (requestIds: string[]) => Promise<void>,
  onLinearTicketRequests?: (requestIds: string[]) => Promise<void>,
  onRecoverableSentryFailure?: (
    error: SentryConnectionUnavailableError,
  ) => Promise<void>,
  onAutomaticSuggestionPullRequestRequests?: (
    requestIds: string[],
  ) => Promise<void>,
): Promise<{
  report: string;
  previousResponseId?: string;
  sandboxSessionState?: Record<string, unknown>;
  updatedIssueIds?: string[];
}> {
  const threadMode = job.kind === "slack_thread_investigation";
  const replay = job.kind === "investigation" && job.replay;
  const issueFollowup = job.kind === "investigation" ? job.slackIssueFollowup : undefined;
  const issueUpdateFollowup = Boolean(issueFollowup?.issueIds.length);
  const updatedIssueIds = new Set<string>();
  const investigationInput = toInvestigationInput(job.request);
  const scanMode = investigationInput.provider === "scan";
  const assistant = threadMode &&
    isSlackAssistantRequest(investigationInput) &&
    await organizationHasCapability(job.config.organizationId, "simplified_navigation");
  let sentryConnectionDegraded = false;
  const awsAlarmTriggered =
    investigationInput.provider === "slack" &&
    investigationInput.attributes?.slackAlertProvider === "aws";
  const writeTrace = async (event: InvestigationTraceEvent): Promise<void> => {
    try {
      await onTraceEvent(event);
    } catch (error) {
      console.error(
        JSON.stringify(
          investigationTraceWriteFailure({
            error,
            investigationId: job.investigationId,
            jobId: traceContext.jobId,
            traceEventType: event.type,
          }),
        ),
      );
      throw error;
    }
  };
  const initialMessage = initialInvestigationMessage(investigationInput);
  await writeTrace(traceEvent("session.started"));
  await writeTrace(initialMessage.traceEvent);

  const config = sandboxAgentConfig(environment);
  setDefaultOpenAIKey(config.openAiApiKey);
  setTracingDisabled(true);
  // Operator replays are not charged to the organization.
  const usageBillable = !replay &&
    await agentUsageIsBillable(job.config.organizationId);

  const [
    runtimeProfile,
    awsConnections,
    gcpConnections,
    axiomConnection,
    datadogConnection,
    dash0Connections,
    postHogConnections,
    grafanaConnections,
    sentryConnection,
    customMcpConnections,
    clickStackConnection,
    linearConnection,
    vercelConnections,
    slackConnection,
    upstashConnection,
    langfuseConnections,
    supabaseConnections,
    workspaceSecrets,
  ] = await Promise.all([
    getRuntimeProfile(job.runtimeProfileId),
    getRuntimeAwsConnections(job.config.id),
    getRuntimeGcpConnections(job.config.id),
    loadAxiomConnectionForInvestigation({
      investigationId: job.investigationId,
      versionId: job.config.id,
    }),
    getRuntimeDatadogConnection(job.config.id),
    getRuntimeDash0Connections(job.config.id),
    getRuntimePostHogConnections(job.config.id),
    getRuntimeGrafanaConnections(job.config.id),
    loadSentryConnectionForInvestigation({
      investigationId: job.investigationId,
      investigationInput,
      onRecoverableFailure: async (error) => {
        sentryConnectionDegraded = true;
        await onRecoverableSentryFailure?.(error);
      },
      versionId: job.config.id,
    }),
    getRuntimeCustomMcpConnections(job.config.id),
    getRuntimeClickStackConnection(job.config.id),
    getRuntimeLinearConnection(job.config.id),
    getRuntimeVercelConnections(job.config.id),
    getRuntimeSlackConnection(job.config.id),
    getRuntimeUpstashConnection(job.config.id),
    getRuntimeLangfuseConnections(job.config.id),
    getRuntimeSupabaseConnections(job.config.id),
    getRuntimeWorkspaceSecrets(job.config.id),
  ]);
  const awsServers = await Promise.all(
    awsConnections.map((connection) => createAwsMcpServer(connection, environment)),
  );
  const gcpServers = gcpConnections.flatMap((connection) =>
    createGcpMcpServers(connection, environment)
  );
  const datadogServer = datadogConnection
    ? createDatadogMcpServer(datadogConnection)
    : null;
  const axiomServer = axiomConnection
    ? createAxiomMcpServer(axiomConnection)
    : null;
  const dash0Servers = dash0Connections.map(createDash0McpServer);
  const postHogServers = postHogConnections.map(createPostHogMcpServer);
  const grafanaServers = await Promise.all(
    grafanaConnections.map((connection) =>
      createGrafanaMcpServer(connection, environment),
    ),
  );
  const sentryServer = sentryConnection
    ? createSentryMcpServer(sentryConnection, {
        investigationId: job.investigationId,
      })
    : null;
  // Custom MCP contracts cannot guarantee observation-only tools, so scans do
  // not attach them. Interactive investigations retain the configured server.
  const customMcpServers = scanMode
    ? []
    : customMcpConnections.map(createCustomMcpServer);
  const clickStackServer = clickStackConnection
    ? createClickStackMcpServer(clickStackConnection)
    : null;
  const linearServer = linearConnection
    ? createLinearMcpServer(linearConnection)
    : null;
  const slackServer = slackConnection
    ? createSlackSearchServer(slackConnection)
    : null;
  const upstashServer = upstashConnection
    ? createUpstashMcpServer(upstashConnection)
    : null;
  const upstashTools = upstashConnection
    ? createUpstashCliTools(upstashConnection)
    : [];
  const langfuseServers = langfuseConnections.map(createLangfuseMcpServer);
  const effectiveSupabaseConnections = scanMode
    ? supabaseConnections.map((connection) =>
        connection.accessMode === "read_write"
          ? {
              ...connection,
              accessMode: "read_only" as const,
              mcpUrl: supabaseMcpUrl({
                accessMode: "read_only",
                projectRef: connection.projectRef,
              }),
            }
          : connection,
      )
    : supabaseConnections;
  const supabaseServers = effectiveSupabaseConnections.map(createSupabaseMcpServer);
  const secrets = connectionSecrets([
    ...awsConnections,
    axiomConnection,
    datadogConnection,
    ...dash0Connections,
    ...postHogConnections,
    ...grafanaConnections,
    sentryConnection,
    ...customMcpConnections,
    clickStackConnection,
    linearConnection,
    ...vercelConnections,
    slackConnection,
    upstashConnection,
    ...langfuseConnections,
    ...supabaseConnections,
  ]);
  // Provider errors reach both the agent and the logs in full, minus the
  // credentials this investigation holds.
  const describeConnectError = (error: unknown) =>
    safeInvestigationError(error, environment, secrets);
  const connectFailureEvent = (serverName: string, error: unknown) =>
    contextServerConnectFailureEvent({
      awsConnections,
      gcpConnections,
      customMcpConnections,
      dash0Connections,
      postHogConnections,
      grafanaConnections,
      error: describeConnectError(error),
      investigationId: job.investigationId,
      langfuseConnections,
      serverName,
      supabaseConnections,
      upstashConnection,
    });
  const contextServers = [
    axiomServer,
    datadogServer,
    sentryServer,
    clickStackServer,
    linearServer,
    slackServer,
    upstashServer,
    ...dash0Servers,
    ...postHogServers,
    ...grafanaServers,
    ...langfuseServers,
    ...supabaseServers,
    ...awsServers,
    ...gcpServers,
    ...customMcpServers,
  ]
    .filter((server): server is NonNullable<typeof server> => server !== null)
    // A provider outage should not stop the investigation. The agent sees the
    // error and decides whether to reconnect.
    .map((server) => new RecoverableMcpServer(server, describeConnectError));

  const sandboxName = `responder-investigation-${job.investigationId}`;
  const client = new DaytonaSandboxClient({
    ...daytonaClientOptions(config),
    name: sandboxName,
    pauseOnExit: threadMode,
  });

  let session: DaytonaSandboxSession | null = null;
  let meter: SandboxMeter | null = null;
  let modelUsage: Usage | undefined;

  try {
    await Promise.all(
      contextServers.map(async (server) => {
        try {
          await connectContextServer(server);
        } catch (error) {
          console.error(
            JSON.stringify(connectFailureEvent(server.name, error)),
          );
          server.markUnavailable(error);
        }
      }),
    );
    let awsSkillContext = "";
    const awsSkillServer = contextServers.find(
      (server) => server.available && server.name === awsServers[0]?.name,
    );
    if (awsAlarmTriggered && awsSkillServer) {
      const loadedSkills = await loadAwsAlarmSkillContext(awsSkillServer);
      awsSkillContext = loadedSkills.content;
      for (const failure of loadedSkills.failures) {
        console.error(
          JSON.stringify({
            error: safeInvestigationError(failure.error, environment),
            event: "aws_investigation_skill_load_failed",
            investigationId: job.investigationId,
            skillName: failure.skillName,
          }),
        );
      }
    }
    const sessionRuntime = threadMode
      ? await getSlackInvestigationSessionRuntime(
          job.slackInvestigationSessionId,
        )
      : null;
    if (threadMode && !sessionRuntime) {
      throw new Error("Slack investigation session not found");
    }
    const persistedState = sessionRuntime?.sandboxSessionState;
    if (threadMode && persistedState) {
      try {
        session = await client.resume(
          await client.deserializeSessionState(persistedState),
        );
      } catch (error) {
        // Daytona deletes a paused thread sandbox after a day; the thread
        // continues in a fresh one.
        console.error(JSON.stringify({
          errorCode: error instanceof Error ? error.name : typeof error,
          event: "investigation_sandbox_resume_failed",
          investigationId: job.investigationId,
        }));
      }
    }
    session ??= await createDaytonaSandboxSession(client, config, sandboxName);
    meter = startSandboxMeter({
      billable: usageBillable,
      organizationId: job.config.organizationId,
      snapshot: Boolean(config.sandboxSnapshotName),
      workload: "investigation",
      workloadId: job.investigationId,
    });
    const sessionMarker = "/home/daytona/workspace/.responder/thread-session-ready";
    const sessionReady = Boolean(
      persistedState && await session.pathExists(sessionMarker),
    );
    if (!sessionReady) {
      await configureDaytonaSandboxLifecycle(
        session,
        config,
        workspaceSecrets,
        threadMode ? pausedThreadSandboxLifetimeMinutes : 0,
      );
      if (!config.sandboxSnapshotName) await prepareDaytonaSandbox(session);
    } else {
      // Thread sandboxes set up before the deletion interval existed never
      // expire; give them the same interval.
      await configureDaytonaSandboxLifecycle(
        session,
        config,
        [],
        pausedThreadSandboxLifetimeMinutes,
      );
    }
    const repositories = sessionReady
      ? threadMode && job.refreshWorkspace
        ? await refreshRuntimeRepositories(session, job.config.id)
        : await loadCheckedOutRepositories(session)
      : await checkoutRuntimeRepositories(session, job.config.id);
    const repositorySkills = await loadRepositorySkills(session, repositories);
    const repositoryInstructions = await discoverRepositoryInstructions(
      session,
      repositories,
    );
    if (threadMode && !sessionReady) {
      await session.materializeEntry({
        entry: { type: "file", content: "ready\n" },
        path: sessionMarker,
      });
    }
    const reportTool = replay
      ? createCaptureInvestigationReplayReportTool({
          promptParts: runtimeProfile?.promptParts,
          investigationId: job.investigationId,
          organizationId: job.config.organizationId,
        })
      : threadMode
        ? null
        : createSubmitInvestigationReportTool({
          promptParts: runtimeProfile?.promptParts,
          investigationId: job.investigationId,
          organizationId: job.config.organizationId,
          environment,
          repositories,
          allowCodeChanges: !scanMode,
          onAutomaticPullRequestRequests: scanMode
            ? undefined
            : onAutomaticPullRequestRequests,
          onLinearTicketRequests: scanMode ? undefined : onLinearTicketRequests,
        });
    const issueSearchTool = createSearchExistingIssuesTool({
      organizationId: job.config.organizationId,
      environment,
    });
    const suggestionTools = !threadMode && !replay && !issueUpdateFollowup
      ? [
          createSearchSuggestionsTool({
            organizationId: job.config.organizationId,
            environment,
          }),
          createSuggestionTool({
            agentConfigVersionId: job.config.id,
            investigationId: job.investigationId,
            organizationId: job.config.organizationId,
            repositories,
            environment,
            onAutomaticPullRequestRequests:
              onAutomaticSuggestionPullRequestRequests,
          }),
        ]
      : [];
    const issueUpdateTool = issueUpdateFollowup && issueFollowup
      ? createIssueRemediationUpdateTool({
          allowedIssueIds: new Set(issueFollowup.issueIds),
          onUpdated: (issueId) => updatedIssueIds.add(issueId),
          organizationId: job.config.organizationId,
          repositories,
        })
      : null;
    const repositoryInspectionTools = createRepositoryInspectionTools({
      repositories,
      session,
    });
    const vercelTools = createVercelTools(vercelConnections);
    const awsInspectionTools = createAwsInspectionTools(awsConnections, {
      environment,
    });
    const integrationsUrl = responderIntegrationsUrl(environment);
    const assistantTools = assistant
      ? [
          ...(repositories.length > 0
            ? [createThreadPullRequestTool({
                agentConfigVersionId: job.config.id,
                investigationId: job.investigationId,
                organizationId: job.config.organizationId,
                repositories,
                session,
              })]
            : []),
          ...createWorkspaceTools({
            actorUserId: await getSlackThreadModeActor(job.config.organizationId),
            automationsEnabled: await organizationHasCapability(
              job.config.organizationId,
              "automations",
            ),
            integrationsUrl,
            organizationId: job.config.organizationId,
          }),
        ]
      : [];
    const instructions = investigationInstructions({
      agentPrompt: assistant
        ? customTagModeInstructions(job.config.prompt) ?? ""
        : job.config.prompt,
      awsAlarmTriggered,
      awsAccountNames: awsConnections.map(
        (connection) =>
          `${connection.displayName} (${connection.roleArn.split(":")[4] ?? "unknown"})`,
      ),
      awsSkillContext,
      gcpProjectNames: gcpConnections.map(
        (connection) => `${connection.displayName} (${connection.projectId})`,
      ),
      axiomConnected: axiomServer !== null,
      customMcpNames: scanMode
        ? []
        : customMcpConnections.map((connection) => connection.displayName),
      clickStackConnected: clickStackServer !== null,
      datadogConnected: datadogServer !== null,
      dash0AccountNames: dash0Connections.map(
        (connection) => connection.displayName,
      ),
      postHogAccountNames: postHogConnections.map(
        (connection) => connection.displayName,
      ),
      grafanaInstanceNames: grafanaConnections.map(
        (connection) => connection.displayName,
      ),
      repositories,
      runtimeSystemPrompt: runtimeProfile?.systemPrompt,
      runtimePromptParts: runtimeProfile?.promptParts,
      sentryConnected: sentryServer !== null,
      sentryUnavailable: sentryConnectionDegraded,
      linearConnected: linearServer !== null,
      langfuseProjectNames: langfuseConnections.map(
        (connection) => connection.displayName,
      ),
      supabaseConnections: effectiveSupabaseConnections.map((connection) => ({
        accessMode: connection.accessMode,
        displayName: connection.displayName,
      })),
      repositoryInstructions,
      slackChannels: slackConnection?.channels,
      upstashConnected: upstashServer !== null,
      workspaceSecrets,
      vercelAccountIds: vercelConnections.map((connection) => connection.accountId),
      threadMode,
      ...(assistant
        ? { assistant: { integrationsUrl, pullRequests: repositories.length > 0 } }
        : {}),
      scanMode,
      replay,
      ...(issueFollowup
        ? { issueFollowupIssueCount: issueFollowup.issueIds.length }
        : {}),
    });
    // Save the same string passed to the agent so the trace never reconstructs it.
    await writeTrace(investigationInstructionsTraceEvent(instructions));
    const agent = new SandboxAgent({
      name: "Responder investigator",
      model: config.model,
      instructions,
      capabilities: [
        ...investigationCapabilities(replay),
        ...(repositorySkills ? [skills({ from: repositorySkills })] : []),
      ],
      // MCP servers are tenant-configurable and may expose the same generic
      // tool names (for example, `search` or `execute`). Prefix each tool
      // with its server name so one connection cannot prevent an entire
      // investigation from starting.
      mcpConfig: { includeServerInToolNames: true },
      mcpServers: contextServers,
      tools: [
        ...(threadMode
          ? []
          : issueUpdateFollowup
            ? [issueUpdateTool!]
            : [issueSearchTool, reportTool!]),
        ...suggestionTools,
        ...assistantTools,
        ...awsInspectionTools,
        ...repositoryInspectionTools,
        ...upstashTools,
        ...vercelTools,
      ],
    });
    const result = await run(
      agent,
      initialMessage.message,
      {
        maxTurns: investigationMaxTurns,
        sandbox: { session },
        stream: true,
        ...(sessionRuntime?.previousResponseId
          ? { previousResponseId: sessionRuntime.previousResponseId }
          : {}),
      },
    );
    modelUsage = result.state.usage;
    for await (const streamEvent of result) {
      const event = investigationTraceEventFromStream(
        streamEvent,
        environment,
        new Date(),
      );
      if (event) await writeTrace(event);
    }
    await result.completed;
    if (typeof result.finalOutput !== "string" || !result.finalOutput.trim()) {
      throw new Error("OpenAI agent returned an empty report");
    }
    const report = redactDaytonaSecretPlaceholders(result.finalOutput.trim());
    await writeTrace(traceEvent("session.completed"));
    if (threadMode) {
      const sandboxSessionState = await client.serializeSessionState(
        session.state,
      );
      delete sandboxSessionState.apiKey;
      return {
        report,
        sandboxSessionState,
        ...(result.lastResponseId
          ? { previousResponseId: result.lastResponseId }
          : {}),
      };
    }
    return {
      report,
      ...(result.lastResponseId ? { previousResponseId: result.lastResponseId } : {}),
      ...(updatedIssueIds.size > 0
        ? { updatedIssueIds: [...updatedIssueIds] }
        : {}),
    };
  } catch (error) {
    await writeTrace(
      traceEvent("session.failed", {
        error: safeInvestigationError(error, environment),
      }),
    );
    throw error;
  } finally {
    try {
      if (session) {
        if (threadMode) {
          await pauseDaytonaSandbox(session, {
            investigationId: job.investigationId,
            organizationId: job.config.organizationId,
          });
        } else {
          await closeDaytonaSandbox(session, config, {
            investigationId: job.investigationId,
            organizationId: job.config.organizationId,
          });
        }
      }
    } finally {
      await meter?.stop();
      await recordAgentRunUsage({
        billable: usageBillable,
        model: config.model,
        organizationId: job.config.organizationId,
        usage: modelUsage,
        workload: "investigation",
        workloadId: job.investigationId,
      });
    }
    await Promise.all(
      contextServers.map((server) =>
        server.close().catch(() => undefined),
      ),
    );
  }
}
