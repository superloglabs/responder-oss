import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  assertAutomationHarnessModelCompatibility,
  assertAutomationWorkspaceHasNoSymlinkRedirects,
  automationWorkspaceRoot,
  modelBrokerTokenEnvironmentVariable,
  resolveAutomationWorkspacePath,
  validateAutomationContextServers,
  type AutomationHarnessInput,
  type AutomationHarnessResult,
  validateBrokerBaseUrl,
} from "./automation-harness.js";

export const openCodeVersion = "1.18.32";

const installRoot = `${automationWorkspaceRoot}/.responder/opencode/${openCodeVersion}`;
const executable = `${installRoot}/node_modules/.bin/opencode`;
const configPath = `${automationWorkspaceRoot}/.responder/opencode.json`;
const promptPath = `${automationWorkspaceRoot}/.responder/automation-prompt.txt`;
const shellPath = `${automationWorkspaceRoot}/.responder/opencode-shell`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

export async function prepareOpenCodeAutomationHarness(
  session: DaytonaSandboxSession,
): Promise<void> {
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      `unset ${modelBrokerTokenEnvironmentVariable}`,
      `mkdir -p ${shellQuote(installRoot)}`,
      `if [ -x ${shellQuote(executable)} ] && ${shellQuote(executable)} --version | grep -Fqx ${shellQuote(openCodeVersion)}; then exit 0; fi`,
      `npm install --prefix ${shellQuote(installRoot)} --ignore-scripts --no-audit --no-fund --no-package-lock --no-save ${shellQuote(`opencode-ai@${openCodeVersion}`)}`,
      `${shellQuote(executable)} --version | grep -Fqx ${shellQuote(openCodeVersion)}`,
    ].join("\n"),
    maxOutputTokens: 2_000,
    workdir: automationWorkspaceRoot,
  });
  if (!commandSucceeded(output)) {
    throw new Error("Unable to prepare the pinned OpenCode automation harness");
  }
}

export function openCodeAutomationConfig(input: AutomationHarnessInput) {
  assertAutomationHarnessModelCompatibility("opencode", input.model);
  const brokerBaseUrl = validateBrokerBaseUrl(input.model.brokerBaseUrl);
  const contextServers = validateAutomationContextServers(input.contextServers);
  const npm = input.model.provider === "anthropic"
    ? "@ai-sdk/anthropic"
    : "@ai-sdk/openai";
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
          [input.model.model]: { name: input.model.model },
        },
        name: "Responder model broker",
        npm,
        options: {
          apiKey: `{env:${modelBrokerTokenEnvironmentVariable}}`,
          baseURL: brokerBaseUrl,
        },
      },
    },
    share: "disabled",
  };
}

export function buildOpenCodeAutomationCommand(
  input: AutomationHarnessInput,
): string {
  const workspacePath = resolveAutomationWorkspacePath(input.workspacePath);
  assertAutomationHarnessModelCompatibility("opencode", input.model);
  return [
    "set -eu",
    `if [ -z "\${${modelBrokerTokenEnvironmentVariable}:-}" ]; then echo 'Model broker token is unavailable' >&2; exit 1; fi`,
    `trap ${shellQuote(`rm -f ${shellQuote(promptPath)} ${shellQuote(configPath)}`)} EXIT`,
    `prompt=$(cat ${shellQuote(promptPath)})`,
    `cd ${shellQuote(workspacePath)}`,
    `OPENCODE_CONFIG=${shellQuote(configPath)} ${shellQuote(executable)} run --format json --model ${shellQuote(`responder/${input.model.model}`)} -- "$prompt"`,
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
  await prepareOpenCodeAutomationHarness(session);
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
    cmd: `chmod 700 ${shellQuote(shellPath)}\n${buildOpenCodeAutomationCommand(input)}`,
    maxOutputTokens: 20_000,
    workdir: automationWorkspaceRoot,
  });
  if (!commandSucceeded(output)) throw new Error("OpenCode automation harness failed");
  return { eventStream: output };
}
