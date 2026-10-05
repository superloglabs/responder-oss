import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { materializeAutomationSkills } from "./automation-skills.js";

const skill = {
  description: "Look up invoices.",
  files: [{ content: "openapi: 3.1.0\n", path: "reference/openapi.yaml" }],
  instructions: "Use the API.",
  name: "billing-api",
  secrets: [],
};

function session(output: string) {
  return {
    execCommand: vi.fn().mockResolvedValue(output),
    materializeEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaytonaSandboxSession & {
    execCommand: ReturnType<typeof vi.fn>;
    materializeEntry: ReturnType<typeof vi.fn>;
  };
}

describe("materializeAutomationSkills", () => {
  it("empties the skills folder only after `.responder` resolves to itself", async () => {
    const sandbox = session("Process exited with code 0");

    await materializeAutomationSkills(sandbox, [skill]);

    const command: string = sandbox.execCommand.mock.calls[0]![0].cmd;
    const guard = command.indexOf("[ \"$(realpath -e -- '/home/daytona/workspace/.responder')\" = '/home/daytona/workspace/.responder' ]");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(command.indexOf("rm -rf -- '/home/daytona/workspace/.responder/skills'"));
    expect(command.startsWith("set -eu\n")).toBe(true);
    expect(sandbox.materializeEntry.mock.calls.map(([call]) => call.path)).toEqual([
      "/home/daytona/workspace/.responder/skills/billing-api/SKILL.md",
      "/home/daytona/workspace/.responder/skills/billing-api/reference/openapi.yaml",
    ]);
  });

  it("writes nothing when the folder cannot be prepared, such as through a symlink", async () => {
    const sandbox = session("Process exited with code 1");

    await expect(materializeAutomationSkills(sandbox, [skill])).rejects.toThrow(
      "Unable to prepare the sandbox skills folder",
    );
    expect(sandbox.materializeEntry).not.toHaveBeenCalled();
  });
});
