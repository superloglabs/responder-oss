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
  brokerBaseUrl: string;
  model: string;
  provider: string;
}

export interface AutomationHarnessInput {
  model: AutomationModelRoute;
  prompt: string;
  workspacePath: string;
}

export interface AutomationHarnessResult {
  eventStream: string;
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
  if (harness === "claude_agent_sdk" && route.provider !== "anthropic") {
    throw new Error("Claude Agent SDK automations require an Anthropic model");
  }
  validateBrokerBaseUrl(route.brokerBaseUrl);
}

export function resolveAutomationWorkspacePath(workspacePath: string): string {
  const resolved = path.posix.resolve(workspacePath);
  if (
    resolved !== automationWorkspaceRoot &&
    !resolved.startsWith(`${automationWorkspaceRoot}/`)
  ) {
    throw new Error("Automation workspace must be inside the sandbox workspace");
  }
  return resolved;
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
