import { run, setDefaultOpenAIKey, setTracingDisabled } from "@openai/agents";
import { Capabilities, SandboxAgent } from "@openai/agents/sandbox";
import {
  DaytonaSandboxClient,
  type DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import {
  getRuntimeAwsConnections,
  getRuntimeAxiomConnection,
  getRuntimeCustomMcpConnections,
  getRuntimeDatadogConnection,
  getRuntimeClickStackConnection,
  getRuntimeLinearConnection,
  getRuntimeLangfuseConnections,
  getRuntimeSlackConnection,
  getRuntimeSentryConnection,
  getRuntimeUpstashConnection,
  getRuntimeVercelConnections,
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
import {
  createAwsMcpServer,
  loadAwsAlarmSkillContext,
} from "./aws.js";
import { createAwsInspectionTools } from "./aws-inspection-tools.js";
import { createAxiomMcpServer } from "./axiom.js";
import { createDatadogMcpServer } from "./datadog.js";
import { createCustomMcpServer, createLinearMcpServer } from "./custom-mcp.js";
import { createClickStackMcpServer } from "./clickstack.js";
import { createLangfuseMcpServer } from "./langfuse.js";
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
  createUpstashCliTools,
  createUpstashMcpServer,
} from "./upstash.js";
import {
  redactDaytonaSecretPlaceholders,
  workspaceSecretUsageInstructions,
} from "./secret-safety.js";
import { createVercelTools } from "./vercel.js";

export interface SandboxAgentConfig extends DaytonaClientConfig {
  model: string;
  openAiApiKey: string;
}

export function safeInvestigationError(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Investigation agent failed";
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
  awsConnections?: ReadonlyArray<{ accountId: string }>;
  customMcpConnections: ReadonlyArray<{ accountId: string }>;
  langfuseConnections?: ReadonlyArray<{ accountId: string }>;
  error: unknown;
  investigationId: string;
  serverName: string;
  upstashConnection?: { accountId: string } | null;
}) {
  const protectedProvider = input.serverName.startsWith("aws-")
    ? "AWS"
    : input.serverName.startsWith("langfuse-")
      ? "Langfuse"
      : input.serverName.startsWith("upstash-")
        ? "Upstash"
        : null;
  const accountId = input.serverName.startsWith("upstash-")
    ? input.upstashConnection?.accountId
    : input.serverName.startsWith("aws-")
      ? input.awsConnections?.find(
          (connection) => input.serverName === `aws-${connection.accountId}`,
        )?.accountId
      : input.serverName.startsWith("langfuse-")
        ? input.langfuseConnections?.find(
            (connection) =>
              input.serverName === `langfuse-${connection.accountId}`,
          )?.accountId
        : input.customMcpConnections.find(
            (connection) => input.serverName === `custom-mcp-${connection.accountId}`,
          )?.accountId;
  return {
    ...(accountId ? { accountId } : {}),
    error: protectedProvider
      ? `Unable to connect to ${protectedProvider} context`
      : input.error instanceof Error
        ? input.error.message
        : String(input.error),
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
  return Capabilities.default();
}

export function investigationInstructions(input: {
  agentPrompt: string;
  awsAlarmTriggered?: boolean;
  awsAccountNames?: string[];
  awsSkillContext?: string;
  customMcpNames?: string[];
  axiomConnected?: boolean;
  datadogConnected: boolean;
  clickStackConnected: boolean;
  repositories: CheckedOutRepository[];
  runtimeSystemPrompt?: string | null;
  sentryConnected: boolean;
  linearConnected?: boolean;
  langfuseProjectNames?: string[];
  slackChannels?: Array<{ id: string; name: string }>;
  upstashConnected?: boolean;
  workspaceSecrets?: Array<{
    environmentVariable: string;
    allowedHosts: string[];
  }>;
  vercelAccountIds?: string[];
}): string {
  const awsAccountNames = input.awsAccountNames ?? [];
  const customMcpNames = input.customMcpNames ?? [];
  const langfuseProjectNames = input.langfuseProjectNames ?? [];
  const slackChannels = input.slackChannels ?? [];
  const workspaceSecrets = input.workspaceSecrets ?? [];
  const vercelAccountIds = input.vercelAccountIds ?? [];
  const observabilityConnected =
    input.datadogConnected ||
    input.axiomConnected ||
    input.sentryConnected ||
    input.clickStackConnected ||
    input.upstashConnected ||
    langfuseProjectNames.length > 0 ||
    vercelAccountIds.length > 0 ||
    awsAccountNames.length > 0 ||
    customMcpNames.length > 0;
  return [
    input.runtimeSystemPrompt,
    input.agentPrompt,
    "Investigate only the alert and context provided by Responder.",
    awsAccountNames.length > 0
      ? `Use the connected read-only AWS tools to inspect relevant infrastructure, configuration, telemetry, and service health before concluding. Connected AWS accounts: ${awsAccountNames.join(", ")}. Never request secret values.`
      : null,
    input.awsAlarmTriggered && awsAccountNames.length > 0
      ? "This investigation was triggered by an AWS alarm forwarded through Slack. Locate the exact CloudWatch alarm by its normalized name and region first. Inspect its current configuration, state history, metric data, affected resource, and relevant logs around the transition. Treat the Slack notification as a pointer, not as proof of root cause."
      : null,
    input.awsSkillContext
      ? `Use the following AWS investigation guides when planning service-specific inspection:\n\n${input.awsSkillContext}`
      : null,
    awsAccountNames.length > 0
      ? "Prefer the typed aws_inspect_cloudwatch_alarm, aws_inspect_cloudwatch_metric, aws_query_cloudwatch_logs, aws_inspect_sqs_queue, and aws_inspect_lambda_function tools for AWS evidence. If aws___run_script is necessary, use top-level await instead of asyncio.run, use exact PascalCase AWS API operation names, and inspect every nested api_calls result. An outer success status does not mean the nested AWS calls succeeded; retry failed nested calls with corrected operation names."
      : null,
    input.datadogConnected
      ? "Use the connected Datadog tools to inspect the matching logs and surrounding service activity before concluding."
      : null,
    input.axiomConnected
      ? "Use the connected read-only Axiom tools to inspect telemetry relevant to the Slack alert, including logs, traces, metrics, and surrounding service activity, before concluding. Never create, update, or delete Axiom resources."
      : null,
    input.clickStackConnected
      ? "Use the connected ClickStack tools to inspect relevant logs, traces, metrics, and surrounding service activity before concluding. Do not create, update, or delete ClickStack resources during an investigation."
      : null,
    input.sentryConnected
      ? "Use the connected read-only Sentry tools to inspect the issue, related events, traces, and relevant historical telemetry before concluding."
      : null,
    input.upstashConnected
      ? "Use list_upstash_resources first to locate relevant Redis, Vector, Search, QStash, or team resources, then use the read-only Upstash inspection and runtime tools for evidence. Workflow and QStash runtime history are available through the connected Upstash tools. Never create, update, delete, retry, publish, or otherwise mutate Upstash resources or data."
      : null,
    langfuseProjectNames.length > 0
      ? `Use the connected read-only Langfuse tools to inspect relevant traces, observations, scores, metrics, prompts, and alerts before concluding. Start with bounded observation or metric searches, then inspect specific observations for evidence. Never create or modify Langfuse prompts, scores, datasets, annotations, alerts, or other resources. Connected Langfuse projects: ${langfuseProjectNames.join(", ")}.`
      : null,
    input.linearConnected
      ? "Use the connected Linear tools to inspect relevant project and issue context. Never use a Linear connection tool to write. If the saved report creates new issues, Responder queues a separate job to create the requested Linear tickets and record their identifiers and links."
      : null,
    vercelAccountIds.length > 0
      ? `Use the connected read-only Vercel tools to inspect selected projects, deployments, build and runtime logs, and project domains. Search the Vercel API catalog before calling an operation. Never attempt to retrieve environment-variable values or other secrets. Connected Vercel account IDs: ${vercelAccountIds.join(", ")}.`
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
    "For every new issue, submit one or more concrete remediation options with the report. A code_change must include a complete unified git diff based on files you inspected. Use external_action for work outside the attached repositories, describe the action for a human, and include a self-contained prompt they can pass to an agent with access to that system. Do not claim that a proposed diff has been applied.",
    "Do not include actions performed by Responder during the investigation in an issue timeline; include only events in the incident's causal sequence.",
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

  const [
    runtimeProfile,
    awsConnections,
    axiomConnection,
    datadogConnection,
    sentryConnection,
    customMcpConnections,
    clickStackConnection,
    linearConnection,
    vercelConnections,
    slackConnection,
    upstashConnection,
    langfuseConnections,
    workspaceSecrets,
  ] = await Promise.all([
    getRuntimeProfile(job.runtimeProfileId),
    getRuntimeAwsConnections(job.config.id),
    getRuntimeAxiomConnection(job.config.id),
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
    getRuntimeVercelConnections(job.config.id),
    getRuntimeSlackConnection(job.config.id),
    getRuntimeUpstashConnection(job.config.id),
    getRuntimeLangfuseConnections(job.config.id),
    getRuntimeWorkspaceSecrets(job.config.id),
  ]);
  const awsServers = await Promise.all(
    awsConnections.map((connection) => createAwsMcpServer(connection, environment)),
  );
  const datadogServer = datadogConnection
    ? createDatadogMcpServer(datadogConnection)
    : null;
  const axiomServer = axiomConnection
    ? createAxiomMcpServer(axiomConnection)
    : null;
  const sentryServer = sentryConnection
    ? createSentryMcpServer(sentryConnection, {
        investigationId: job.investigationId,
      })
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
  const upstashServer = upstashConnection
    ? createUpstashMcpServer(upstashConnection)
    : null;
  const upstashTools = upstashConnection
    ? createUpstashCliTools(upstashConnection)
    : [];
  const langfuseServers = langfuseConnections.map(createLangfuseMcpServer);
  const contextServers = [
    axiomServer,
    datadogServer,
    sentryServer,
    clickStackServer,
    linearServer,
    slackServer,
    upstashServer,
    ...langfuseServers,
    ...awsServers,
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
                awsConnections,
                customMcpConnections,
                error,
                investigationId: job.investigationId,
                langfuseConnections,
                serverName: server.name,
                upstashConnection,
              }),
            ),
          );
          if (server.name.startsWith("upstash-")) {
            throw new Error("Unable to connect to Upstash context");
          }
          if (server.name.startsWith("aws-")) {
            throw new Error("Unable to connect to AWS context");
          }
          if (server.name.startsWith("langfuse-")) {
            throw new Error("Unable to connect to Langfuse context");
          }
          throw error;
        }
      }),
    );
    let awsSkillContext = "";
    if (awsAlarmTriggered && awsServers[0]) {
      const loadedSkills = await loadAwsAlarmSkillContext(awsServers[0]);
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
    const vercelTools = createVercelTools(vercelConnections);
    const awsInspectionTools = createAwsInspectionTools(awsConnections, {
      environment,
    });
    const instructions = investigationInstructions({
      agentPrompt: job.config.prompt,
      awsAlarmTriggered,
      awsAccountNames: awsConnections.map(
        (connection) =>
          `${connection.displayName} (${connection.roleArn.split(":")[4] ?? "unknown"})`,
      ),
      awsSkillContext,
      axiomConnected: axiomServer !== null,
      customMcpNames: customMcpConnections.map((connection) => connection.displayName),
      clickStackConnected: clickStackServer !== null,
      datadogConnected: datadogServer !== null,
      repositories,
      runtimeSystemPrompt: runtimeProfile?.systemPrompt,
      sentryConnected: sentryServer !== null,
      linearConnected: linearServer !== null,
      langfuseProjectNames: langfuseConnections.map(
        (connection) => connection.displayName,
      ),
      slackChannels: slackConnection?.channels,
      upstashConnected: upstashServer !== null,
      workspaceSecrets,
      vercelAccountIds: vercelConnections.map((connection) => connection.accountId),
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
        maxTurns: 20,
        sandbox: { session },
        stream: true,
      },
    );
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
