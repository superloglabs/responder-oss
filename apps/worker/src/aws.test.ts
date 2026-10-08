import { describe, expect, it, vi } from "vitest";
import {
  AWS_ALARM_SKILL_NAMES,
  awsReadOnlyToolFilter,
  loadAwsAlarmSkillContext,
} from "./aws.js";

describe("AWS MCP tool filtering", () => {
  it("exposes only tools explicitly annotated as read-only", async () => {
    await expect(
      awsReadOnlyToolFilter({}, { annotations: { readOnlyHint: true } }),
    ).resolves.toBe(true);
    await expect(
      awsReadOnlyToolFilter({}, { annotations: { readOnlyHint: false } }),
    ).resolves.toBe(false);
    await expect(awsReadOnlyToolFilter({}, { name: "unknown" })).resolves.toBe(
      false,
    );
  });

  it("exposes the IAM-guarded script runner and task polling tools", async () => {
    await expect(
      awsReadOnlyToolFilter({}, { name: "aws___run_script" }),
    ).resolves.toBe(true);
    await expect(
      awsReadOnlyToolFilter({}, {
        annotations: { readOnlyHint: false },
        name: "aws___get_tasks",
      }),
    ).resolves.toBe(true);
    await expect(
      awsReadOnlyToolFilter({}, { name: "run_script" }),
    ).resolves.toBe(true);
  });

  it("keeps other generic AWS execution tools hidden", async () => {
    await expect(
      awsReadOnlyToolFilter({}, { name: "aws___call_aws" }),
    ).resolves.toBe(false);
    await expect(
      awsReadOnlyToolFilter({}, { name: "aws___get_presigned_url" }),
    ).resolves.toBe(false);
  });
});

describe("AWS alarm skill loading", () => {
  it("loads each service guide into the agent context", async () => {
    const callTool = vi.fn().mockImplementation(
      (_toolName: string, input: { skill_name: string }) =>
        Promise.resolve([
          {
            text: JSON.stringify({
              content: { skill_content: `guide for ${input.skill_name}` },
            }),
            type: "text",
          },
        ]),
    );

    const result = await loadAwsAlarmSkillContext({ callTool } as never);

    expect(result.failures).toEqual([]);
    expect(result.content).toContain("guide for aws-observability");
    expect(result.content).toContain("guide for aws-messaging-and-streaming");
    expect(result.content).toContain("guide for aws-serverless");
    expect(callTool).toHaveBeenCalledTimes(AWS_ALARM_SKILL_NAMES.length);
    expect(callTool).toHaveBeenNthCalledWith(
      1,
      "aws___retrieve_skill",
      { skill_name: "aws-observability" },
    );
  });

  it("keeps available guides when one guide fails", async () => {
    const callTool = vi.fn().mockImplementation(
      (_toolName: string, input: { skill_name: string }) =>
        input.skill_name === "aws-messaging-and-streaming"
          ? Promise.reject(new Error("temporarily unavailable"))
          : Promise.resolve([
              { text: `guide for ${input.skill_name}`, type: "text" },
            ]),
    );

    const result = await loadAwsAlarmSkillContext({ callTool } as never);

    expect(result.content).toContain("guide for aws-observability");
    expect(result.content).toContain("guide for aws-serverless");
    expect(result.failures).toEqual([
      {
        error: "temporarily unavailable",
        skillName: "aws-messaging-and-streaming",
      },
    ]);
  });

  it("reports MCP error results instead of treating them as guide text", async () => {
    const callTool = vi.fn().mockImplementation(
      (_toolName: string, input: { skill_name: string }) => {
        const result = [
          { text: `failed to load ${input.skill_name}`, type: "text" },
        ];
        Object.assign(result, { isError: true });
        return Promise.resolve(result);
      },
    );

    const result = await loadAwsAlarmSkillContext({ callTool } as never);

    expect(result.content).toBe("");
    expect(result.failures).toEqual(
      AWS_ALARM_SKILL_NAMES.map((skillName) => ({
        error: `failed to load ${skillName}`,
        skillName,
      })),
    );
  });
});
