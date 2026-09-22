import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  assertAutomationHarnessModelCompatibility,
  automationWorkspaceRoot,
  type AutomationHarness,
  type AutomationHarnessInput,
  type AutomationHarnessResult,
  modelBrokerTokenEnvironmentVariable,
  resolveAutomationWorkspacePath,
  validateBrokerBaseUrl,
} from "./automation-harness.js";

export const codexCliVersion = "0.155.1";

const codexInstallRoot = `${automationWorkspaceRoot}/.responder/codex/${codexCliVersion}`;
const codexExecutable = `${codexInstallRoot}/node_modules/.bin/codex`;
const codexHome = `${automationWorkspaceRoot}/.responder/codex-home`;
const promptPath = `${automationWorkspaceRoot}/.responder/automation-prompt.txt`;

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexAutomationCommand(
  input: AutomationHarnessInput,
): string {
  assertAutomationHarnessModelCompatibility("codex", input.model);
  const workspacePath = resolveAutomationWorkspacePath(input.workspacePath);
  const brokerBaseUrl = validateBrokerBaseUrl(input.model.brokerBaseUrl);
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    input.model.model,
    "--cd",
    workspacePath,
    "--config",
    `model_provider=${tomlString("responder")}`,
    "--config",
    `model_providers.responder.name=${tomlString("Responder model broker")}`,
    "--config",
    `model_providers.responder.base_url=${tomlString(brokerBaseUrl)}`,
    "--config",
    `model_providers.responder.env_key=${tomlString(modelBrokerTokenEnvironmentVariable)}`,
    "--config",
    `model_providers.responder.wire_api=${tomlString("responses")}`,
    "--config",
    `shell_environment_policy.inherit=${tomlString("core")}`,
    "--config",
    "shell_environment_policy.ignore_default_excludes=false",
    "--config",
    `shell_environment_policy.filters={ ${modelBrokerTokenEnvironmentVariable} = ${tomlString("exclude")} }`,
    "--config",
    "allow_login_shell=false",
    "-",
  ];

  return [
    "set -eu",
    `if [ -z "\${${modelBrokerTokenEnvironmentVariable}:-}" ]; then echo 'Model broker token is unavailable' >&2; exit 1; fi`,
    `mkdir -p ${shellQuote(codexHome)}`,
    `trap ${shellQuote(`rm -f ${shellQuote(promptPath)}`)} EXIT`,
    `CODEX_HOME=${shellQuote(codexHome)} ${shellQuote(codexExecutable)} ${args.map(shellQuote).join(" ")} < ${shellQuote(promptPath)}`,
  ].join("\n");
}

export async function prepareCodexAutomationHarness(
  session: DaytonaSandboxSession,
): Promise<void> {
  const expectedVersion = `codex-cli ${codexCliVersion}`;
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      `mkdir -p ${shellQuote(codexInstallRoot)}`,
      `if [ -x ${shellQuote(codexExecutable)} ] && [ "$(${shellQuote(codexExecutable)} --version)" = ${shellQuote(expectedVersion)} ]; then exit 0; fi`,
      `npm install --prefix ${shellQuote(codexInstallRoot)} --no-audit --no-fund --no-package-lock --no-save ${shellQuote(`@openai/codex@${codexCliVersion}`)}`,
      `[ "$(${shellQuote(codexExecutable)} --version)" = ${shellQuote(expectedVersion)} ]`,
    ].join("\n"),
    maxOutputTokens: 2_000,
    workdir: automationWorkspaceRoot,
  });
  if (!commandSucceeded(output)) {
    throw new Error("Unable to prepare the pinned Codex automation harness");
  }
}

export async function runCodexAutomation(
  session: DaytonaSandboxSession,
  input: AutomationHarnessInput,
): Promise<AutomationHarnessResult> {
  await prepareCodexAutomationHarness(session);
  await session.materializeEntry({
    entry: { type: "file", content: input.prompt },
    path: promptPath,
  });
  const output = await session.execCommand({
    cmd: buildCodexAutomationCommand(input),
    maxOutputTokens: 20_000,
    workdir: automationWorkspaceRoot,
  });
  if (!commandSucceeded(output)) {
    throw new Error("Codex automation harness failed");
  }
  return { eventStream: output };
}

export const codexAutomationHarness: AutomationHarness = {
  kind: "codex",
  run: runCodexAutomation,
};
