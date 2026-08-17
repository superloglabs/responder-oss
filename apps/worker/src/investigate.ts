import { run, setDefaultOpenAIKey, setTracingDisabled } from "@openai/agents";
import { Capabilities, SandboxAgent } from "@openai/agents/sandbox";
import {
  DaytonaSandboxClient,
  type DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import {
  getRuntimeCustomMcpConnections,
  getRuntimeDatadogConnection,
  getRuntimeClickStackConnection,
  getRuntimeLinearConnection,
  getRuntimeSlackConnection,
  getRuntimeSentryConnection,
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
import type { InvestigationJob } from "@responder/core/jobs";
import { investigationPrompt, toInvestigationInput } from "@responder/core/investigations/input";
import { createDatadogMcpServer } from "./datadog.js";
import { createCustomMcpServer, createLinearMcpServer } from "./custom-mcp.js";
import { createClickStackMcpServer } from "./clickstack.js";
import { createSearchExistingIssuesTool } from "./issue-search.js";
import {
  checkoutRuntimeRepositories,
  type CheckedOutRepository,
} from "./repositories.js";
import { createRepositoryInspectionTools } from "./repository-inspection.js";
import {
  createCaptureInvestigationReplayReportTool,
  createSubmitInvestigationReportTool,
} from "./report.js";
import {
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  prepareDaytonaSandbox,
} from "./sandbox.js";
import {
  investigationTraceEventFromStream,
  traceEvent,
} from "./trace.js";
import { createSentryMcpServer } from "./sentry.js";
import { createSlackMcpServer } from "./slack.js";
import {
  redactDaytonaSecretPlaceholders,
  workspaceSecretUsageInstructions,
} from "./secret-safety.js";

export interface SandboxAgentConfig extends DaytonaClientConfig {
  model: string;
  openAiApiKey: string;
}

export function safeInvestigationError(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let message =
    error instanceof Error ? error.message : "Investigation agent failed";
  for (const name of ["OPENAI_API_KEY", "DAYTONA_API_KEY"] as const) {
    const value = environment[name];
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  return redactDaytonaSecretPlaceholders(message).slice(0, 2_000);
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

export function contextServerConnectFailureEvent(input: {
  customMcpConnections: ReadonlyArray<{ accountId: string }>;
  error: unknown;
  investigationId: string;
  serverName: string;
}) {
  const accountId = input.customMcpConnections.find(
    (connection) => input.serverName === `custom-mcp-${connection.accountId}`,
  )?.accountId;
  return {
    ...(accountId ? { accountId } : {}),
    error: input.error instanceof Error ? input.error.message : String(input.error),
    event: "context_server_connect_failed",
    investigationId: input.investigationId,
    server: input.serverName,
  };
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
  return Capabilities.default().filter(
    (capability) => capability.type === "compaction",
  );
}

export function investigationInstructions(input: {
  agentPrompt: string;
  customMcpNames?: string[];
  datadogConnected: boolean;
  clickStackConnected: boolean;
  repositories: CheckedOutRepository[];
  runtimeSystemPrompt?: string | null;
  sentryConnected: boolean;
  linearConnected?: boolean;
  slackChannels?: Array<{ id: string; name: string }>;
  workspaceSecrets?: Array<{
    environmentVariable: string;
    allowedHosts: string[];
  }>;
}): string {
  const customMcpNames = input.customMcpNames ?? [];
  const slackChannels = input.slackChannels ?? [];
  const workspaceSecrets = input.workspaceSecrets ?? [];
  const observabilityConnected =
    input.datadogConnected ||
    input.sentryConnected ||
    input.clickStackConnected ||
    customMcpNames.length > 0;
  return [
    input.runtimeSystemPrompt,
    input.agentPrompt,
    "Investigate only the alert and context provided by Responder.",
    input.datadogConnected
      ? "Use the connected Datadog tools to inspect the matching logs and surrounding service activity before concluding."
      : null,
    input.clickStackConnected
      ? "Use the connected ClickStack tools to inspect relevant logs, traces, metrics, and surrounding service activity before concluding. Do not create, update, or delete ClickStack resources during an investigation."
      : null,
    input.sentryConnected
      ? "Use the connected read-only Sentry tools to inspect the issue, related events, traces, and relevant historical telemetry before concluding."
      : null,
    input.linearConnected
      ? "Use the connected Linear tools to inspect relevant project and issue context. Never use a Linear connection tool to write. If the saved report creates new issues, Responder queues a separate job to create the requested Linear tickets and record their identifiers and links."
      : null,
    customMcpNames.length > 0
      ? `Use the connected custom MCP tools when they can provide relevant evidence. Connected MCPs: ${customMcpNames.join(", ")}.`
      : null,
    slackChannels.length > 0
      ? `Use the read-only Slack tools to inspect relevant conversation history in these selected channels only: ${slackChannels.map((channel) => `#${channel.name} (${channel.id})`).join(", ")}.`
      : null,
    !observabilityConnected
      ? "No observability data source is connected. Clearly say when the alert alone is insufficient."
      : null,
    input.repositories.length > 0
      ? [
          "The selected repositories are already checked out:",
          ...input.repositories.map(
            (repository) =>
              `- ${repository.repository}: ${repository.path} (${repository.branch} at ${repository.sha})`,
          ),
          "Inspect the relevant files before claiming a code-level root cause.",
        ].join("\n")
      : "No repositories are attached to this Agent version. Clearly distinguish code-level hypotheses from verified root causes.",
    "Use the read-only repository inspection tools to list, search, and read attached repository files.",
    "This run is only for investigation and reporting. Do not modify repository code or create pull requests. Pull request remediation, when enabled, runs separately after the report is saved.",
    "Do not expose credentials or secret values.",
    workspaceSecretUsageInstructions(workspaceSecrets),
    "For every distinct problem you find, call search_existing_issues before deciding whether it is a new issue or a recurrence. Use an existing issue ID when the evidence matches; this attaches the investigation to that issue instead of creating a duplicate.",
    "Before your final response, you must call submit_investigation_report exactly once with the structured result. That action saves or attaches the issues and posts the report to Slack.",
    "After submitting, return a concise Markdown report with: Summary, Evidence, Impact, and Recommended next step.",
    "Clearly say when the available evidence is insufficient.",
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
  job: InvestigationJob,
  environment: NodeJS.ProcessEnv = process.env,
  onTraceEvent: (event: InvestigationTraceEvent) => Promise<void>,
  traceContext: { jobId: string },
  onAutomaticPullRequestRequests?: (requestIds: string[]) => Promise<void>,
  onLinearTicketRequests?: (requestIds: string[]) => Promise<void>,
): Promise<string> {
  const investigationInput = toInvestigationInput(job.request);
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

  const [
    runtimeProfile,
    datadogConnection,
    sentryConnection,
    customMcpConnections,
    clickStackConnection,
    linearConnection,
    slackConnection,
    workspaceSecrets,
  ] = await Promise.all([
    getRuntimeProfile(job.runtimeProfileId),
    getRuntimeDatadogConnection(job.config.id),
    getRuntimeSentryConnection(job.config.id, investigationInput)
      .then((connection) => {
        if (!connection && investigationInput.provider === "sentry") {
          console.info(
            JSON.stringify({
              event: "sentry_connection_unavailable",
              investigationId: job.investigationId,
            }),
          );
        }
        return connection;
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            event: "sentry_connection_lookup_failed",
            investigationId: job.investigationId,
          }),
        );
        throw error;
      }),
    getRuntimeCustomMcpConnections(job.config.id),
    getRuntimeClickStackConnection(job.config.id),
    getRuntimeLinearConnection(job.config.id),
    getRuntimeSlackConnection(job.config.id),
    getRuntimeWorkspaceSecrets(job.config.id),
  ]);
  const datadogServer = datadogConnection
    ? createDatadogMcpServer(datadogConnection)
    : null;
  const sentryServer = sentryConnection
    ? createSentryMcpServer(sentryConnection)
    : null;
  const customMcpServers = customMcpConnections.map(createCustomMcpServer);
  const clickStackServer = clickStackConnection
    ? createClickStackMcpServer(clickStackConnection)
    : null;
  const linearServer = linearConnection
    ? createLinearMcpServer(linearConnection)
    : null;
  const slackServer = slackConnection
    ? createSlackMcpServer(slackConnection)
    : null;
  const contextServers = [
    datadogServer,
    sentryServer,
    clickStackServer,
    linearServer,
    slackServer,
    ...customMcpServers,
  ].filter(
    (server): server is NonNullable<typeof server> => server !== null,
  );

  const client = new DaytonaSandboxClient({
    ...daytonaClientOptions(config),
    name: `responder-investigation-${job.investigationId}`,
    pauseOnExit: false,
  });

  let session: DaytonaSandboxSession | null = null;

  try {
    await Promise.all(
      contextServers.map(async (server) => {
        try {
          await server.connect();
        } catch (error) {
          console.error(
            JSON.stringify(
              contextServerConnectFailureEvent({
                customMcpConnections,
                error,
                investigationId: job.investigationId,
                serverName: server.name,
              }),
            ),
          );
          throw error;
        }
      }),
    );
    session = await client.create();
    await configureDaytonaSandboxLifecycle(session, config, workspaceSecrets);
    await prepareDaytonaSandbox(session);
    const repositories = await checkoutRuntimeRepositories(
      session,
      job.config.id,
    );
    const reportTool = job.replay
      ? createCaptureInvestigationReplayReportTool({
          investigationId: job.investigationId,
          organizationId: job.config.organizationId,
        })
      : createSubmitInvestigationReportTool({
          investigationId: job.investigationId,
          organizationId: job.config.organizationId,
          environment,
          onAutomaticPullRequestRequests,
          onLinearTicketRequests,
        });
    const issueSearchTool = createSearchExistingIssuesTool({
      organizationId: job.config.organizationId,
      environment,
    });
    const repositoryInspectionTools = createRepositoryInspectionTools({
      repositories,
      session,
    });
    const instructions = investigationInstructions({
      agentPrompt: job.config.prompt,
      customMcpNames: customMcpConnections.map((connection) => connection.displayName),
      clickStackConnected: clickStackServer !== null,
      datadogConnected: datadogServer !== null,
      repositories,
      runtimeSystemPrompt: runtimeProfile?.systemPrompt,
      sentryConnected: sentryServer !== null,
      linearConnected: linearServer !== null,
      slackChannels: slackConnection?.channels,
      workspaceSecrets,
    });
    // Save the same string passed to the agent so the trace never reconstructs it.
    await writeTrace(investigationInstructionsTraceEvent(instructions));
    const agent = new SandboxAgent({
      name: "Responder investigator",
      model: config.model,
      instructions,
      capabilities: investigationCapabilities(job.replay),
      mcpServers: contextServers,
      tools: [
        issueSearchTool,
        reportTool,
        ...repositoryInspectionTools,
      ],
    });
    const result = await run(
      agent,
      initialMessage.message,
      {
        maxTurns: 20,
        sandbox: { session },
        stream: true,
      },
    );
    for await (const streamEvent of result) {
      const event = investigationTraceEventFromStream(
        streamEvent,
        environment,
      );
      if (event) await writeTrace(event);
    }
    await result.completed;
    if (typeof result.finalOutput !== "string" || !result.finalOutput.trim()) {
      throw new Error("OpenAI agent returned an empty report");
    }
    await writeTrace(traceEvent("session.completed"));
    return redactDaytonaSecretPlaceholders(result.finalOutput.trim());
  } catch (error) {
    await writeTrace(
      traceEvent("session.failed", {
        error: safeInvestigationError(error, environment),
      }),
    );
    throw error;
  } finally {
    if (session) {
      await closeDaytonaSandbox(session, config, {
        investigationId: job.investigationId,
        organizationId: job.config.organizationId,
      });
    }
    await Promise.all(
      contextServers.map((server) =>
        server.close().catch(() => undefined),
      ),
    );
  }
}
