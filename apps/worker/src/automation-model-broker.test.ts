import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { runBrokeredAutomationProof } from "./automation-model-broker.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const grantId = "21212121-2121-4121-8121-212121212121";

function dependencies() {
  return {
    createGrant: vi.fn().mockResolvedValue({
      expiresAt: new Date("2026-09-22T16:10:00.000Z"),
      id: grantId,
      token: "run-scoped-token",
    }),
    now: () => new Date("2026-09-22T16:00:00.000Z"),
    revokeGrant: vi.fn().mockResolvedValue(undefined),
    runHarness: vi.fn().mockResolvedValue({ eventStream: "completed" }),
    runInSandbox: vi.fn(async (input) =>
      input.run(
        { state: { environment: {} } } as unknown as DaytonaSandboxSession,
        async (operation: () => Promise<unknown>) => operation(),
      )
    ),
  };
}

const input = {
  brokerBaseUrl: "https://responder.example/api/automation-model-broker/v1",
  config: { daytonaApiKey: "sandbox-api-key" },
  maxOutputTokensPerRequest: 4_096,
  maxRequests: 8,
  maxRuntimeSeconds: 600,
  leaseId: "31313131-3131-4131-8131-313131313131",
  model: "gpt-5.1-codex",
  organizationId,
  prompt: "Return a short acknowledgement.",
  providerApiKey: "provider-secret",
  runId: "run-1",
  workspacePath: "/home/daytona/workspace",
};

describe("brokered automation proof", () => {
  it("passes only the opaque grant into the fresh sandbox", async () => {
    const deps = dependencies();

    await expect(
      runBrokeredAutomationProof(input, deps),
    ).resolves.toEqual({ eventStream: "completed" });

    expect(deps.createGrant).toHaveBeenCalledWith({
      apiKey: "provider-secret",
      expiresAt: new Date("2026-09-22T16:10:00.000Z"),
      maxOutputTokensPerRequest: 4_096,
      maxRequests: 8,
      model: "gpt-5.1-codex",
      leaseId: "31313131-3131-4131-8131-313131313131",
      organizationId,
      provider: "openai",
      runId: "run-1",
    });
    const sandboxInput = deps.runInSandbox.mock.calls[0]![0];
    expect(sandboxInput.brokerToken).toBe("run-scoped-token");
    expect(JSON.stringify(sandboxInput)).not.toContain("provider-secret");
    expect(deps.runHarness).toHaveBeenCalledWith(
      expect.anything(),
      {
        contextServers: [],
        model: {
          brokerBaseUrl:
            "https://responder.example/api/automation-model-broker/v1",
          model: "gpt-5.1-codex",
          provider: "openai",
        },
        prompt: "Return a short acknowledgement.",
        workspacePath: "/home/daytona/workspace",
      },
    );
    expect(deps.revokeGrant).toHaveBeenCalledWith({
      grantId,
      organizationId,
      runId: "run-1",
    });
  });

  it("revokes the grant when sandbox execution fails", async () => {
    const deps = dependencies();
    const failure = new Error("sandbox failed");
    deps.runInSandbox.mockRejectedValue(failure);

    await expect(runBrokeredAutomationProof(input, deps)).rejects.toBe(failure);
    expect(deps.revokeGrant).toHaveBeenCalledWith({
      grantId,
      organizationId,
      runId: "run-1",
    });
  });
});
