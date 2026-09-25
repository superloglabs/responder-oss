import { supportsAutomationHarness } from "../../../packages/core/src/automations/model-providers.js";
import path from "node:path";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";

export const automationWorkspaceRoot = "/home/daytona/workspace";
export const modelBrokerTokenEnvironmentVariable =
  "RESPONDER_MODEL_BROKER_TOKEN";

export type AutomationHarnessKind =
  | "claude_agent_sdk"
  | "codex"
  | "opencode";

export interface AutomationModelRoute {
  subscription?: { authJson: string; persist: (authJson: string) => Promise<void> };
  brokerBaseUrl: string;
  model: string;
  provider: string;
}

export interface AutomationHarnessInput {
  contextServers: AutomationContextServer[];
  // Where the harness writes its events while it runs, inside the workspace.
  eventsPath?: string;
  model: AutomationModelRoute;
  prompt: string;
  workspacePath: string;
}

// The sandbox snapshot installs the pinned harnesses here. A harness uses its
// prebuilt copy when the version matches and installs its own otherwise.
export const prebuiltHarnessRoot = "/opt/responder";
export const prebuiltHarnessMarker = "responder-harness=prebuilt";

export interface AutomationContextServer {
  name: string;
  url: string;
}

export interface AutomationHarnessResult {
  eventStream: string;
}

// The run page shows the transcript parsed from this output, so keep all of it
// rather than the middle-truncated default.
export const automationHarnessMaxOutputTokens = 1_000_000;

// Carries the output of a failed harness so the run can still store its
// transcript. The message never includes the output.
export class AutomationHarnessError extends Error {
  constructor(
    message: string,
    readonly eventStream: string,
  ) {
    super(message);
    this.name = "AutomationHarnessError";
  }
}

export interface AutomationHarness {
  readonly kind: AutomationHarnessKind;
  run(
    session: DaytonaSandboxSession,
    input: AutomationHarnessInput,
  ): Promise<AutomationHarnessResult>;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

export function assertAutomationHarnessModelCompatibility(
  harness: AutomationHarnessKind,
  route: AutomationModelRoute,
): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(route.provider)) {
    throw new Error("Model provider must be a normalized provider identifier");
  }
  if (
    route.model.length === 0 ||
    route.model.length > 255 ||
    containsControlCharacter(route.model)
  ) {
    throw new Error("Model must be a non-empty identifier without control characters");
  }
  if (harness === "claude_agent_sdk" && route.provider !== "anthropic") throw new Error("Claude Agent SDK automations require an Anthropic model");
  if (!supportsAutomationHarness(route.provider, harness, Boolean(route.subscription))) {
    throw new Error("The selected harness does not support this model provider");
  }
  validateBrokerBaseUrl(route.brokerBaseUrl);
}

export function resolveAutomationWorkspacePath(workspacePath: string): string {
  if (!path.posix.isAbsolute(workspacePath)) {
    throw new Error("Automation workspace path must be absolute");
  }
  const resolved = path.posix.resolve(workspacePath);
  if (
    resolved !== automationWorkspaceRoot &&
    !resolved.startsWith(`${automationWorkspaceRoot}/`)
  ) {
    throw new Error("Automation workspace must be inside the sandbox workspace");
  }
  return resolved;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Runs the harness with its output in the events file, then prints the file
// so the command result still carries the whole stream.
export function harnessInvocation(command: string, eventsPath?: string): string {
  if (!eventsPath) return command;
  const path = shellQuote(resolveAutomationWorkspacePath(eventsPath));
  return [
    "harness_status=0",
    `${command} > ${path} || harness_status=$?`,
    `cat ${path}`,
    'exit "$harness_status"',
  ].join("\n");
}

export async function assertAutomationWorkspaceHasNoSymlinkRedirects(
  session: DaytonaSandboxSession,
  workspacePath: string,
): Promise<void> {
  const resolvedWorkspacePath = resolveAutomationWorkspacePath(workspacePath);
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      `unset ${modelBrokerTokenEnvironmentVariable}`,
      `if [ ! -d ${shellQuote(resolvedWorkspacePath)} ]; then exit 42; fi`,
      `resolved=$(realpath -e -- ${shellQuote(resolvedWorkspacePath)})`,
      `[ "$resolved" = ${shellQuote(resolvedWorkspacePath)} ]`,
    ].join("\n"),
    maxOutputTokens: 100,
    workdir: automationWorkspaceRoot,
  });
  if (!/(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output)) {
    if (/(?:^|\n)Process exited with code 42(?:\n|$)/u.test(output)) {
      throw new Error("Automation workspace does not exist");
    }
    throw new Error("Automation workspace cannot use symlink redirects");
  }
}

export function validateBrokerBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Model broker base URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Model broker base URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Model broker base URL cannot contain credentials, query parameters, or a fragment",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

export function validateAutomationContextServers(
  servers: AutomationContextServer[],
): AutomationContextServer[] {
  const names = new Set<string>();
  return servers.map((server) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(server.name) || names.has(server.name)) {
      throw new Error("Automation context server names must be unique identifiers");
    }
    names.add(server.name);
    return { name: server.name, url: validateBrokerBaseUrl(server.url) };
  });
}
