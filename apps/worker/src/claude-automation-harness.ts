import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  AutomationHarnessError,
  assertAutomationHarnessModelCompatibility,
  assertAutomationWorkspaceHasNoSymlinkRedirects,
  automationHarnessMaxOutputTokens,
  automationWorkspaceRoot,
  harnessInvocation,
  modelBrokerTokenEnvironmentVariable,
  prebuiltHarnessMarker,
  prebuiltHarnessRoot,
  resolveAutomationWorkspacePath,
  validateAutomationContextServers,
  validateAutomationToolServer,
  type AutomationHarnessInput,
  type AutomationHarnessResult,
  validateBrokerBaseUrl,
} from "./automation-harness.js";

export const claudeAgentSdkVersion = "0.3.280";

const installRoot = `${automationWorkspaceRoot}/.responder/claude-agent-sdk/${claudeAgentSdkVersion}`;
const sdkModulePath = "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
const sdkModule = `${installRoot}/${sdkModulePath}`;
const prebuiltSdkModule = `${prebuiltHarnessRoot}/claude-agent-sdk/${claudeAgentSdkVersion}/${sdkModulePath}`;
const runnerPath = `${automationWorkspaceRoot}/.responder/claude-agent-sdk-runner.mjs`;
const promptPath = `${automationWorkspaceRoot}/.responder/automation-prompt.txt`;
// Claude Code waits on an MCP tool call indefinitely by default, so one stalled
// context provider would hold the run until its runtime limit.
export const claudeMcpToolTimeoutMs = 120_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

const runner = (modulePath: string) => `import { readFile } from "node:fs/promises";
import { query } from ${JSON.stringify(modulePath)};

const prompt = await readFile(process.env.RESPONDER_AUTOMATION_PROMPT_PATH, "utf8");
const contextServers = JSON.parse(process.env.RESPONDER_AUTOMATION_CONTEXT_SERVERS ?? "[]");
const toolServer = process.env.RESPONDER_AUTOMATION_TOOL_SERVER
  ? JSON.parse(process.env.RESPONDER_AUTOMATION_TOOL_SERVER)
  : null;
const conversation = query({
  prompt,
  options: {
    allowDangerouslySkipPermissions: true,
    cwd: process.env.RESPONDER_AUTOMATION_WORKSPACE,
    maxTurns: 400,
    mcpServers: {
      ...Object.fromEntries(contextServers.map((server) => [server.name, {
        type: "http",
        url: server.url,
        headers: { authorization: \`Bearer \${process.env.RESPONDER_MODEL_BROKER_TOKEN}\` },
      }])),
      ...(toolServer ? {
        [toolServer.name]: { type: "stdio", command: toolServer.command, args: toolServer.args },
      } : {}),
    },
    model: process.env.RESPONDER_AUTOMATION_MODEL,
    permissionMode: "bypassPermissions",
    permissionPrompts: "none",
    settingSources: [],
  },
});
for await (const message of conversation) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
`;

export async function prepareClaudeAutomationHarness(
  session: DaytonaSandboxSession,
): Promise<void> {
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      `unset ${modelBrokerTokenEnvironmentVariable}`,
      `if [ -f ${shellQuote(prebuiltSdkModule)} ]; then echo ${shellQuote(prebuiltHarnessMarker)}; exit 0; fi`,
      `mkdir -p ${shellQuote(installRoot)}`,
      `if [ -f ${shellQuote(sdkModule)} ]; then exit 0; fi`,
      `npm install --prefix ${shellQuote(installRoot)} --ignore-scripts --no-audit --no-fund --no-package-lock --no-save ${shellQuote(`@anthropic-ai/claude-agent-sdk@${claudeAgentSdkVersion}`)}`,
      `[ -f ${shellQuote(sdkModule)} ]`,
    ].join("\n"),
    maxOutputTokens: 2_000,
    workdir: automationWorkspaceRoot,
  });
  if (!commandSucceeded(output)) {
    throw new Error("Unable to prepare the pinned Claude automation harness");
  }
  await session.materializeEntry({
    entry: { type: "file", content: runner(output.includes(prebuiltHarnessMarker) ? prebuiltSdkModule : sdkModule) },
    path: runnerPath,
  });
}

export function buildClaudeAutomationCommand(
  input: AutomationHarnessInput,
): string {
  assertAutomationHarnessModelCompatibility("claude_agent_sdk", input.model);
  const workspacePath = resolveAutomationWorkspacePath(input.workspacePath);
  // Claude Code appends /v1/messages itself, so it takes the broker root.
  const brokerBaseUrl = validateBrokerBaseUrl(input.model.brokerBaseUrl)
    .replace(/\/v1$/u, "");
  const contextServers = validateAutomationContextServers(input.contextServers);
  const toolServer = validateAutomationToolServer(input.toolServer, contextServers);
  const outputLimit = input.model.maxOutputTokensPerRequest;
  if (outputLimit !== undefined && (!Number.isSafeInteger(outputLimit) || outputLimit <= 0)) {
    throw new Error("Maximum output tokens per request must be a positive integer");
  }
  // Claude Code asks for more output than a grant allows unless capped.
  const maxOutputTokens = outputLimit === undefined ? "" : ` CLAUDE_CODE_MAX_OUTPUT_TOKENS=${outputLimit}`;
  // Sandboxes run as root. IS_SANDBOX tells Claude Code the environment is
  // isolated so it accepts bypassPermissions there.
  return [
    "set -eu",
    `if [ -z "\${${modelBrokerTokenEnvironmentVariable}:-}" ]; then echo 'Model broker token is unavailable' >&2; exit 1; fi`,
    `trap ${shellQuote(`rm -f ${shellQuote(promptPath)}`)} EXIT`,
    harnessInvocation(
      `ANTHROPIC_AUTH_TOKEN="$${modelBrokerTokenEnvironmentVariable}" ANTHROPIC_BASE_URL=${shellQuote(brokerBaseUrl)} CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1${maxOutputTokens} IS_SANDBOX=1 MCP_TOOL_TIMEOUT=${claudeMcpToolTimeoutMs} RESPONDER_AUTOMATION_CONTEXT_SERVERS=${shellQuote(JSON.stringify(contextServers))} RESPONDER_AUTOMATION_MODEL=${shellQuote(input.model.model)} RESPONDER_AUTOMATION_PROMPT_PATH=${shellQuote(promptPath)}${toolServer ? ` RESPONDER_AUTOMATION_TOOL_SERVER=${shellQuote(JSON.stringify(toolServer))}` : ""} RESPONDER_AUTOMATION_WORKSPACE=${shellQuote(workspacePath)} node ${shellQuote(runnerPath)}`,
      input.eventsPath,
    ),
  ].join("\n");
}

export async function runClaudeAutomation(
  session: DaytonaSandboxSession,
  input: AutomationHarnessInput,
): Promise<AutomationHarnessResult> {
  await assertAutomationWorkspaceHasNoSymlinkRedirects(
    session,
    input.workspacePath,
  );
  await prepareClaudeAutomationHarness(session);
  await session.materializeEntry({
    entry: { type: "file", content: input.prompt },
    path: promptPath,
  });
  const output = await session.execCommand({
    cmd: buildClaudeAutomationCommand(input),
    maxOutputTokens: automationHarnessMaxOutputTokens,
    workdir: automationWorkspaceRoot,
  });
  if (!commandSucceeded(output)) throw new AutomationHarnessError("Claude automation harness failed", output);
  return { eventStream: output };
}
