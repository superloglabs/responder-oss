import { describe, expect, it } from "vitest";
import {
  awsReadOnlyToolFilter,
  createRefreshingAwsCredentialsProvider,
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
