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

export const openCodeVersion = "1.18.32";

const installRoot = `${automationWorkspaceRoot}/.responder/opencode/${openCodeVersion}`;
const executable = `${installRoot}/node_modules/.bin/opencode`;
const prebuiltExecutable = `${prebuiltHarnessRoot}/opencode/${openCodeVersion}/node_modules/.bin/opencode`;
const configPath = `${automationWorkspaceRoot}/.responder/opencode.json`;
const promptPath = `${automationWorkspaceRoot}/.responder/automation-prompt.txt`;
const shellPath = `${automationWorkspaceRoot}/.responder/opencode-shell`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

// The JSON events OpenCode printed, skipping the exec output's own lines.
function openCodeEvents(output: string): Array<Record<string, unknown>> {
  return output.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) return [];
    try {
      const event: unknown = JSON.parse(line);
      return event && typeof event === "object" && !Array.isArray(event) ? [event as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function openCodeErrorMessage(event: Record<string, unknown>): string {
  const error = event.error && typeof event.error === "object" ? event.error as Record<string, unknown> : {};
  const data = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : {};
  if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
  return typeof error.name === "string" && error.name ? error.name : "unknown error";
}

// OpenCode can exit 0 after a model error, or without printing anything, so
// a run succeeds only when it exits 0, reports no error and finishes a step.
export function openCodeHarnessFailure(output: string): string | null {
  const events = openCodeEvents(output);
  const error = events.findLast((event) => event.type === "error");
  if (error) return `OpenCode automation harness failed: ${openCodeErrorMessage(error)}`;
  const exitCode = /(?:^|\n)Process exited with code (\d+)(?:\n|$)/u.exec(output)?.[1];
  if (!commandSucceeded(output)) {
    return exitCode ? `OpenCode automation harness failed: OpenCode exited with code ${exitCode}` : "OpenCode automation harness failed";
  }
  if (!events.some((event) => event.type === "step_finish")) {
    return "OpenCode automation harness failed: OpenCode finished without a model response";
  }
  return null;
}

// Returns the executable to run: the snapshot's prebuilt copy when it has the
// pinned version, otherwise a copy installed now.
export async function prepareOpenCodeAutomationHarness(
  session: DaytonaSandboxSession,
): Promise<string> {
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      `unset ${modelBrokerTokenEnvironmentVariable}`,
      `if [ -x ${shellQuote(prebuiltExecutable)} ] && ${shellQuote(prebuiltExecutable)} --version | grep -Fqx ${shellQuote(openCodeVersion)}; then echo ${shellQuote(prebuiltHarnessMarker)}; exit 0; fi`,
      `mkdir -p ${shellQuote(installRoot)}`,
      `if [ -x ${shellQuote(executable)} ] && ${shellQuote(executable)} --version | grep -Fqx ${shellQuote(openCodeVersion)}; then exit 0; fi`,
      `npm install --prefix ${shellQuote(installRoot)} --ignore-scripts --no-audit --no-fund --no-package-lock --no-save ${shellQuote(`opencode-ai@${openCodeVersion}`)}`,
      // Scripts stay off for dependencies; this one links the platform binary.
      `node ${shellQuote(`${installRoot}/node_modules/opencode-ai/postinstall.mjs`)}`,
      `${shellQuote(executable)} --version | grep -Fqx ${shellQuote(openCodeVersion)}`,
    ].join("\n"),
    maxOutputTokens: 2_000,
    workdir: automationWorkspaceRoot,
  });
  if (!commandSucceeded(output)) {
    throw new Error("Unable to prepare the pinned OpenCode automation harness");
  }
  return output.includes(prebuiltHarnessMarker) ? prebuiltExecutable : executable;
}

export function openCodeAutomationConfig(input: AutomationHarnessInput) {
  assertAutomationHarnessModelCompatibility("opencode", input.model);
  const brokerBaseUrl = validateBrokerBaseUrl(input.model.brokerBaseUrl);
  const contextServers = validateAutomationContextServers(input.contextServers);
  const toolServer = validateAutomationToolServer(input.toolServer, contextServers);
  const outputLimit = input.model.maxOutputTokensPerRequest;
  if (outputLimit !== undefined && (!Number.isSafeInteger(outputLimit) || outputLimit <= 0)) {
    throw new Error("Maximum output tokens per request must be a positive integer");
  }
  const npm = input.model.provider === "anthropic"
    ? "@ai-sdk/anthropic"
    : "@ai-sdk/openai-compatible";
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    model: `responder/${input.model.model}`,
    mcp: {
      ...Object.fromEntries(contextServers.map((server) => [
        server.name,
        {
          enabled: true,
          headers: {
            authorization: `Bearer {env:${modelBrokerTokenEnvironmentVariable}}`,
          },
          type: "remote",
          url: server.url,
        },
      ])),
      ...(toolServer
        ? {
            [toolServer.name]: {
              command: [toolServer.command, ...toolServer.args],
              enabled: true,
              type: "local",
            },
          }
        : {}),
    },
    permission: { "*": "allow" },
    shell: shellPath,
    provider: {
      responder: {
        models: {
          [input.model.model]: {
            // OpenCode asks for 32,000 output tokens unless capped, and the
            // broker refuses requests above the grant's limit. A context of
            // 0 keeps OpenCode's default for a model it does not know.
            ...(outputLimit === undefined ? {} : { limit: { context: 0, output: outputLimit } }),
            name: input.model.model,
            tool_call: true,
          },
        },
        name: "Responder model broker",
        npm,
        options: {
          apiKey: `{env:${modelBrokerTokenEnvironmentVariable}}`,
          baseURL: input.model.provider === "anthropic" ? brokerBaseUrl : `${brokerBaseUrl}/providers/${input.model.provider}`,
        },
      },
    },
    share: "disabled",
  };
}

export function buildOpenCodeAutomationCommand(
  input: AutomationHarnessInput,
  openCodeExecutable = executable,
): string {
  const workspacePath = resolveAutomationWorkspacePath(input.workspacePath);
  assertAutomationHarnessModelCompatibility("opencode", input.model);
  return [
    "set -eu",
    `if [ -z "\${${modelBrokerTokenEnvironmentVariable}:-}" ]; then echo 'Model broker token is unavailable' >&2; exit 1; fi`,
    `trap ${shellQuote(`rm -f ${shellQuote(promptPath)} ${shellQuote(configPath)}`)} EXIT`,
    `prompt=$(cat ${shellQuote(promptPath)})`,
    `cd ${shellQuote(workspacePath)}`,
    harnessInvocation(
      `OPENCODE_CONFIG=${shellQuote(configPath)} ${shellQuote(openCodeExecutable)} run --format json --model ${shellQuote(`responder/${input.model.model}`)} -- "$prompt"`,
      input.eventsPath,
    ),
  ].join("\n");
}

export async function runOpenCodeAutomation(
  session: DaytonaSandboxSession,
  input: AutomationHarnessInput,
): Promise<AutomationHarnessResult> {
  await assertAutomationWorkspaceHasNoSymlinkRedirects(
    session,
    input.workspacePath,
  );
  const openCodeExecutable = await prepareOpenCodeAutomationHarness(session);
  await session.materializeEntry({
    entry: {
      type: "file",
      content: `#!/bin/sh\nunset ${modelBrokerTokenEnvironmentVariable}\nexec /bin/sh "$@"\n`,
    },
    path: shellPath,
  });
  await session.materializeEntry({
    entry: { type: "file", content: input.prompt },
    path: promptPath,
  });
  await session.materializeEntry({
    entry: {
      type: "file",
      content: `${JSON.stringify(openCodeAutomationConfig(input), null, 2)}\n`,
    },
    path: configPath,
  });
  const output = await session.execCommand({
    cmd: `chmod 700 ${shellQuote(shellPath)}\n${buildOpenCodeAutomationCommand(input, openCodeExecutable)}`,
    maxOutputTokens: automationHarnessMaxOutputTokens,
    workdir: automationWorkspaceRoot,
  });
  const failure = openCodeHarnessFailure(output);
  if (failure) throw new AutomationHarnessError(failure, output);
  return { eventStream: output };
}
