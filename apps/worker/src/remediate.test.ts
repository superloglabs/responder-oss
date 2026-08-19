import { MaxTurnsExceededError } from "@openai/agents";
import { describe, expect, it } from "vitest";
import {
  remediationApplyPatchPathInstruction,
  remediationFailureMechanismInstruction,
  remediationMaxTurns,
  remediationRunDiagnostics,
} from "./remediate.js";

function maxTurnsError(
  patchOutput = "Invalid Context 0:\nworkspace-secret-value",
) {
  return new MaxTurnsExceededError(
    "Max turns (40) exceeded",
    {
      toJSON: () => ({
        currentTurn: 41,
        generatedItems: [
          {
            agent: { name: "Responder issue fixer" },
            rawItem: {
              callId: "patch-1",
              operation: {
                diff: "@@\n-old\n+new",
                path: "/home/daytona/workspace/repositories/example/app/src/app.ts",
                type: "update_file",
              },
              type: "apply_patch_call",
            },
            type: "tool_call_item",
          },
          {
            agent: { name: "Responder issue fixer" },
            output: patchOutput,
            rawItem: {
              callId: "patch-1",
              output: patchOutput,
              status: "failed",
              type: "apply_patch_call_output",
            },
            type: "tool_call_output_item",
          },
        ],
        maxTurns: 40,
      }),
    } as never,
  );
}

function unreadableMaxTurnsError() {
  return new MaxTurnsExceededError(
    "Max turns (40) exceeded",
    {
      toJSON: () => {
        throw new Error("state serialization failed");
      },
    } as never,
  );
}

describe("remediation agent", () => {
  it("allows forty model turns", () => {
    expect(remediationMaxTurns).toBe(40);
  });

  it("requires absolute paths for native patches", () => {
    expect(remediationApplyPatchPathInstruction).toContain(
      "full absolute checkout path",
    );
    expect(remediationApplyPatchPathInstruction).toContain(
      "Repository-relative paths",
    );
  });

  it("requires an extremely simple failure mechanism", () => {
    expect(remediationFailureMechanismInstruction).toContain(
      "what failed and why",
    );
    expect(remediationFailureMechanismInstruction).toContain(
      "anyone can understand at a glance",
    );
    expect(remediationFailureMechanismInstruction).toContain("no jargon");
  });

  it("retains a safe apply_patch failure category without raw output", () => {
    expect(
      remediationRunDiagnostics(maxTurnsError(), {
        DAYTONA_API_KEY: "daytona-secret",
      }),
    ).toEqual({
      applyPatchFailures: [
        {
          callId: "patch-1",
          error: "Invalid Context 0",
          operation: "update_file",
          path: "/home/daytona/workspace/repositories/example/app/src/app.ts",
        },
      ],
      completedTurns: 40,
      maxTurns: 40,
    });
  });

  it("does not retain unclassified apply_patch output", () => {
    expect(
      remediationRunDiagnostics(maxTurnsError("workspace-secret-value"))
        ?.applyPatchFailures[0]?.error,
    ).toBe("Unclassified apply_patch failure");
  });

  it("categorizes an empty apply_patch failure", () => {
    expect(
      remediationRunDiagnostics(maxTurnsError(""))?.applyPatchFailures[0]
        ?.error,
    ).toBe("apply_patch failed without an error message");
  });

  it("ignores errors without resumable run state", () => {
    expect(remediationRunDiagnostics(new Error("failed"))).toBeUndefined();
  });

  it("does not let unreadable diagnostics mask the remediation failure", () => {
    expect(remediationRunDiagnostics(unreadableMaxTurnsError())).toBeUndefined();
  });
});
