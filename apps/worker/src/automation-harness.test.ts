import { describe, expect, it } from "vitest";
import {
  assertAutomationHarnessModelCompatibility,
  resolveAutomationWorkspacePath,
  validateBrokerBaseUrl,
} from "./automation-harness.js";

const anthropicRoute = {
  brokerBaseUrl: "https://models.responder.test/v1",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
};

describe("automation harness compatibility", () => {
  it("restricts Codex to OpenAI while OpenCode supports other providers", () => {
    expect(() =>
      assertAutomationHarnessModelCompatibility("codex", anthropicRoute),
    ).toThrow("does not support");
    expect(() =>
      assertAutomationHarnessModelCompatibility("opencode", {
        ...anthropicRoute,
      }),
    ).not.toThrow();
  });

  it("allows only Anthropic models for Claude Agent SDK", () => {
    expect(() =>
      assertAutomationHarnessModelCompatibility(
        "claude_agent_sdk",
        anthropicRoute,
      ),
    ).not.toThrow();
    expect(() =>
      assertAutomationHarnessModelCompatibility("claude_agent_sdk", {
        ...anthropicRoute,
        provider: "openai",
      }),
    ).toThrow("require an Anthropic model");
  });

  it("requires a credential-free HTTPS broker URL", () => {
    expect(validateBrokerBaseUrl("https://models.responder.test/v1/")).toBe(
      "https://models.responder.test/v1",
    );
    expect(() => validateBrokerBaseUrl("http://models.test/v1")).toThrow(
      "must use HTTPS",
    );
    expect(() =>
      validateBrokerBaseUrl("https://token@models.test/v1"),
    ).toThrow("cannot contain credentials");
    expect(() =>
      validateBrokerBaseUrl("https://models.test/v1?key=secret"),
    ).toThrow("cannot contain credentials");
  });

  it("keeps harness execution inside the sandbox workspace", () => {
    expect(resolveAutomationWorkspacePath("/home/daytona/workspace/repo")).toBe(
      "/home/daytona/workspace/repo",
    );
    expect(() =>
      resolveAutomationWorkspacePath("/home/daytona/workspace/../../etc"),
    ).toThrow("must be inside the sandbox workspace");
    expect(() => resolveAutomationWorkspacePath("repositories/responder")).toThrow(
      "must be absolute",
    );
    expect(() => resolveAutomationWorkspacePath("")).toThrow(
      "must be absolute",
    );
  });
});
