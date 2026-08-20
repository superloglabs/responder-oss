import { describe, expect, it, vi } from "vitest";
import {
  AWS_ALARM_SKILL_NAMES,
  awsReadOnlyToolFilter,
  createRefreshingAwsCredentialsProvider,
  loadAwsAlarmSkillContext,
} from "./aws.js";

const connection = {
  accountId: "integration-account-1",
  displayName: "AWS · 123456789012",
  externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
  roleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole",
};

interface TestCredentials {
  accessKeyId: string;
  expiration: Date;
  secretAccessKey: string;
  sessionToken: string;
}

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

describe("AWS credential refresh", () => {
  it("reuses valid credentials and refreshes credentials nearing expiration", async () => {
    let now = Date.parse("2026-08-17T12:00:00Z");
    const assume = async () => ({
      accessKeyId: `access-${now}`,
      expiration: new Date(now + 60 * 60 * 1_000),
      secretAccessKey: "secret",
      sessionToken: "token",
    });
    const provider = createRefreshingAwsCredentialsProvider(
      connection,
      {},
      assume,
      () => now,
    );

    const first = await provider();
    expect(await provider()).toBe(first);
    now += 56 * 60 * 1_000;
    expect(await provider()).not.toBe(first);
  });

  it("shares an in-flight refresh between concurrent requests", async () => {
    let resolveCredentials:
      | ((credentials: TestCredentials) => void)
      | undefined;
    const assume = () =>
      new Promise<TestCredentials>((resolve) => {
        resolveCredentials = resolve;
      });
    const provider = createRefreshingAwsCredentialsProvider(
      connection,
      {},
      assume,
    );
    const first = provider();
    const second = provider();
    const credentials = {
      accessKeyId: "access",
      expiration: new Date(Date.now() + 60 * 60 * 1_000),
      secretAccessKey: "secret",
      sessionToken: "token",
    };
    resolveCredentials?.(credentials);
    await expect(Promise.all([first, second])).resolves.toEqual([
      credentials,
      credentials,
    ]);
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
});
