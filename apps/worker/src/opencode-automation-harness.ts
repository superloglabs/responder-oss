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
  const npm = input.model.provider === "anthropic"
    ? "@ai-sdk/anthropic"
    : "@ai-sdk/openai-compatible";
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    model: `responder/${input.model.model}`,
    mcp: Object.fromEntries(contextServers.map((server) => [
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
    permission: { "*": "allow" },
    shell: shellPath,
    provider: {
      responder: {
        models: {
          [input.model.model]: { name: input.model.model, tool_call: true },
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
  if (!commandSucceeded(output)) throw new AutomationHarnessError("OpenCode automation harness failed", output);
  return { eventStream: output };
}
