import {
  parseSubscriptionAuth,
  subscriptionCliVersion,
} from "@responder/core/automations/chatgpt-subscription";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import {
  assertAutomationHarnessModelCompatibility,
  assertAutomationWorkspaceHasNoSymlinkRedirects,
  automationWorkspaceRoot,
  type AutomationHarnessInput,
  type AutomationHarnessResult,
  modelBrokerTokenEnvironmentVariable,
  resolveAutomationWorkspacePath,
  validateAutomationContextServers,
  validateBrokerBaseUrl,
} from "./automation-harness.js";

export const codexCliVersion = subscriptionCliVersion;
const subscriptionHome = "/home/daytona/.responder-subscription-auth";
// Native authentication stays in the trusted parent; all model tools use this
// OS-enforced profile. Never fall back to an unsandboxed subscription run.
export const subscriptionPermissionConfig = [
  'default_permissions="subscription"',
  'approval_policy="never"',
  `permissions.subscription.filesystem={ ":minimal"="read", "/opt/responder/codex"="read", "${automationWorkspaceRoot}"="write", ":tmpdir"="write", ":slash_tmp"="write", "${subscriptionHome}"="deny" }`,
  "permissions.subscription.network.enabled=true",
];

const codexMinimumNodeMajorVersion = 16;
const codexInstallRoot = `${automationWorkspaceRoot}/.responder/codex/${codexCliVersion}`;
const subscriptionInstallRoot = `/opt/responder/codex/${codexCliVersion}`;
const subscriptionExecutable = `${subscriptionInstallRoot}/node_modules/.bin/codex`;
const codexExecutable = `${codexInstallRoot}/node_modules/.bin/codex`;
const codexHome = `${automationWorkspaceRoot}/.responder/codex-home`;
const promptPath = `${automationWorkspaceRoot}/.responder/automation-prompt.txt`;

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function subscriptionRootCommand(command: string): string {
  return `if [ "$(id -u)" -eq 0 ]; then sh -c ${shellQuote(command)}; else sudo -n --preserve-env=PATH,${modelBrokerTokenEnvironmentVariable} -- sh -c ${shellQuote(command)}; fi`;
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
  const contextServers = validateAutomationContextServers(input.contextServers);
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
    ...(input.model.subscription
      ? subscriptionPermissionConfig.flatMap((value) => ["--config", value])
      : ["--dangerously-bypass-approvals-and-sandbox"]),
    "--model",
    input.model.model,
    "--cd",
    workspacePath,
    ...(input.model.subscription
      ? [
          "--config",
          'model_provider="openai"',
          "--config",
          'forced_login_method="chatgpt"',
          "--config",
          'cli_auth_credentials_store="file"',
        ]
      : [
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
        ]),
    "--config",
    `shell_environment_policy.inherit=${tomlString("core")}`,
    "--config",
    "shell_environment_policy.ignore_default_excludes=false",
    "--config",
    `shell_environment_policy.filters={ ${modelBrokerTokenEnvironmentVariable} = ${tomlString("exclude")} }`,
    "--config",
    "allow_login_shell=false",
    ...contextServers.flatMap((server) => [
      "--config",
      `mcp_servers.${server.name}.url=${tomlString(server.url)}`,
      "--config",
      `mcp_servers.${server.name}.bearer_token_env_var=${tomlString(modelBrokerTokenEnvironmentVariable)}`,
    ]),
    "-",
  ];

  return [
    "set -eu",
    `if [ -z "\${${modelBrokerTokenEnvironmentVariable}:-}" ]; then echo 'Model broker token is unavailable' >&2; exit 1; fi`,
    `mkdir -p ${shellQuote(codexHome)}`,
    ...(input.model.subscription
      ? ["unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN"]
      : []),
    `trap ${shellQuote(`rm -f ${shellQuote(promptPath)}`)} EXIT`,
    `CODEX_HOME=${shellQuote(input.model.subscription ? subscriptionHome : codexHome)} ${shellQuote(input.model.subscription ? subscriptionExecutable : codexExecutable)} ${args.map(shellQuote).join(" ")} < ${shellQuote(promptPath)}`,
  ].join("\n");
}

export async function prepareCodexAutomationHarness(
  session: DaytonaSandboxSession,
  subscription = false,
): Promise<void> {
  const installRoot = subscription ? subscriptionInstallRoot : codexInstallRoot;
  const executable = subscription ? subscriptionExecutable : codexExecutable;
  const expectedVersion = `codex-cli ${codexCliVersion}`;
  const command = [
    "set -eu",
    `unset ${modelBrokerTokenEnvironmentVariable}`,
    `mkdir -p ${shellQuote(installRoot)}`,
    `if [ -x ${shellQuote(executable)} ] && [ "$(${shellQuote(executable)} --version)" = ${shellQuote(expectedVersion)} ]; then exit 0; fi`,
    `node -e ${shellQuote(`if (Number(process.versions.node.split(".")[0]) < ${codexMinimumNodeMajorVersion}) process.exit(1)`)}`,
    `npm install --prefix ${shellQuote(installRoot)} --ignore-scripts --no-audit --no-fund --no-package-lock --no-save ${shellQuote(`@openai/codex@${codexCliVersion}`)}`,
    `[ "$(${shellQuote(executable)} --version)" = ${shellQuote(expectedVersion)} ]`,
  ].join("\n");
  const output = await session.execCommand({
    cmd: subscription ? subscriptionRootCommand(command) : command,
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
  await assertAutomationWorkspaceHasNoSymlinkRedirects(
    session,
    input.workspacePath,
  );
  await prepareCodexAutomationHarness(session, !!input.model.subscription);
  await session.materializeEntry({
    entry: { type: "file", content: input.prompt },
    path: promptPath,
  });
  let output = "";
  const authCaches = input.model.subscription
    ? [input.model.subscription.authJson]
    : [];
  let materialized = false;
  try {
    if (input.model.subscription) {
      parseSubscriptionAuth(input.model.subscription.authJson);
      const prepared = await session.execCommand({
        // The trusted launcher needs host root to create the nested user namespace.
        // Tools run with dropped capabilities and the native filesystem policy.
        cmd: subscriptionRootCommand(
          `set -eu; chmod 755 /home/daytona; chown -R 0:0 ${automationWorkspaceRoot}; umask 077; test ! -L ${subscriptionHome}; mkdir -p ${subscriptionHome}; chmod 700 ${subscriptionHome}`,
        ),
        maxOutputTokens: 1000,
        workdir: automationWorkspaceRoot,
      });
      if (!commandSucceeded(prepared))
        throw new Error("Unable to prepare subscription credentials");
      await session.materializeEntry({
        entry: { type: "file", content: input.model.subscription.authJson },
        path: `${subscriptionHome}/auth.json`,
        runAs: "root",
      });
      materialized = true;
    }
    output = await session.execCommand({
      cmd: input.model.subscription
        ? subscriptionRootCommand(
            `chmod 600 ${subscriptionHome}/auth.json\n${buildCodexAutomationCommand(input)}`,
          )
        : buildCodexAutomationCommand(input),
      maxOutputTokens: 20_000,
      workdir: automationWorkspaceRoot,
    });
    if (!commandSucceeded(output))
      throw new Error("Codex automation harness failed");
  } finally {
    if (input.model.subscription) {
      try {
        if (materialized) {
          const bytes = await session.readFile({
            path: `${subscriptionHome}/auth.json`,
            maxBytes: 131_072,
            runAs: "root",
          });
          const refreshed = new TextDecoder().decode(bytes);
          authCaches.push(refreshed);
          await input.model.subscription.persist(refreshed);
        }
      } finally {
        await session.execCommand({
          cmd: `if [ "$(id -u)" -eq 0 ]; then rm -rf ${subscriptionHome}; else sudo -n rm -rf ${subscriptionHome} && sudo -n chown -R "$(id -u):$(id -g)" ${automationWorkspaceRoot}; fi`,
          maxOutputTokens: 1000,
          workdir: automationWorkspaceRoot,
        });
      }
    }
  }
  for (const cache of authCaches) {
    const tokens = parseSubscriptionAuth(cache).tokens;
    for (const secret of [
      tokens.access_token,
      tokens.refresh_token,
      tokens.id_token,
    ])
      output = output.replaceAll(secret, "[redacted]");
  }
  return { eventStream: output };
}
