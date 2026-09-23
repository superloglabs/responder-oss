import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  assertAutomationHarnessModelCompatibility,
  automationWorkspaceRoot,
  modelBrokerTokenEnvironmentVariable,
  resolveAutomationWorkspacePath,
  validateAutomationContextServers,
  type AutomationHarnessInput,
  type AutomationHarnessResult,
  validateBrokerBaseUrl,
} from "./automation-harness.js";

export const claudeAgentSdkVersion = "0.3.280";

const installRoot = `${automationWorkspaceRoot}/.responder/claude-agent-sdk/${claudeAgentSdkVersion}`;
const sdkModule = `${installRoot}/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`;
const runnerPath = `${automationWorkspaceRoot}/.responder/claude-agent-sdk-runner.mjs`;
const promptPath = `${automationWorkspaceRoot}/.responder/automation-prompt.txt`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

const runner = `import { readFile } from "node:fs/promises";
import { query } from ${JSON.stringify(sdkModule)};

const prompt = await readFile(process.env.RESPONDER_AUTOMATION_PROMPT_PATH, "utf8");
const contextServers = JSON.parse(process.env.RESPONDER_AUTOMATION_CONTEXT_SERVERS ?? "[]");
const conversation = query({
  prompt,
  options: {
    allowDangerouslySkipPermissions: true,
    cwd: process.env.RESPONDER_AUTOMATION_WORKSPACE,
    maxTurns: 40,
    mcpServers: Object.fromEntries(contextServers.map((server) => [server.name, {
      type: "http",
      url: server.url,
      headers: { authorization: \`Bearer \${process.env.RESPONDER_MODEL_BROKER_TOKEN}\` },
    }])),
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
    entry: { type: "file", content: runner },
    path: runnerPath,
  });
}

export function buildClaudeAutomationCommand(
  input: AutomationHarnessInput,
): string {
  assertAutomationHarnessModelCompatibility("claude_agent_sdk", input.model);
  const workspacePath = resolveAutomationWorkspacePath(input.workspacePath);
  const brokerBaseUrl = validateBrokerBaseUrl(input.model.brokerBaseUrl);
  const contextServers = validateAutomationContextServers(input.contextServers);
  return [
    "set -eu",
    `if [ -z "\${${modelBrokerTokenEnvironmentVariable}:-}" ]; then echo 'Model broker token is unavailable' >&2; exit 1; fi`,
    `trap ${shellQuote(`rm -f ${shellQuote(promptPath)}`)} EXIT`,
    `ANTHROPIC_AUTH_TOKEN="$${modelBrokerTokenEnvironmentVariable}" ANTHROPIC_BASE_URL=${shellQuote(brokerBaseUrl)} CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 RESPONDER_AUTOMATION_CONTEXT_SERVERS=${shellQuote(JSON.stringify(contextServers))} RESPONDER_AUTOMATION_MODEL=${shellQuote(input.model.model)} RESPONDER_AUTOMATION_PROMPT_PATH=${shellQuote(promptPath)} RESPONDER_AUTOMATION_WORKSPACE=${shellQuote(workspacePath)} node ${shellQuote(runnerPath)}`,
  ].join("\n");
}

export async function runClaudeAutomation(
  session: DaytonaSandboxSession,
  input: AutomationHarnessInput,
): Promise<AutomationHarnessResult> {
  await prepareClaudeAutomationHarness(session);
  await session.materializeEntry({
    entry: { type: "file", content: input.prompt },
    path: promptPath,
  });
  const output = await session.execCommand({
    cmd: buildClaudeAutomationCommand(input),
    maxOutputTokens: 20_000,
    workdir: automationWorkspaceRoot,
  });
  if (!commandSucceeded(output)) throw new Error("Claude automation harness failed");
  return { eventStream: output };
}
