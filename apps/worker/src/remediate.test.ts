import { MaxTurnsExceededError } from "@openai/agents";
import { describe, expect, it } from "vitest";
import {
  remediationApplyPatchPathInstruction,
  remediationMaxTurns,
  remediationRunDiagnostics,
} from "./remediate.js";

function maxTurnsError() {
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
            output: "Invalid Context containing daytona-secret",
            rawItem: {
              callId: "patch-1",
              output: "Invalid Context containing daytona-secret",
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

  it("retains failed apply_patch details with secrets redacted", () => {
    expect(
      remediationRunDiagnostics(maxTurnsError(), {
        DAYTONA_API_KEY: "daytona-secret",
      }),
    ).toEqual({
      applyPatchFailures: [
        {
          callId: "patch-1",
          error: "Invalid Context containing [redacted]",
          operation: "update_file",
          path: "/home/daytona/workspace/repositories/example/app/src/app.ts",
        },
      ],
      completedTurns: 40,
      maxTurns: 40,
    });
  });

  it("ignores errors without resumable run state", () => {
    expect(remediationRunDiagnostics(new Error("failed"))).toBeUndefined();
  });
});
