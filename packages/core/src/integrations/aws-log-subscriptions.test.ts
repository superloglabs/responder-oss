import {
  DeleteAccountPolicyCommand,
  PutAccountPolicyCommand,
  PutDestinationPolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import {
  assumeAwsLogSubscriptionRole,
  AwsLogSubscriptionRoleUnavailableError,
  awsLogDestinationArn,
  awsLogDestinationPolicy,
  awsLogSubscriptionConfig,
  awsLogSubscriptionFilterPattern,
  awsLogSubscriptionPolicyName,
  awsLogSubscriptionPrincipalArnForStacks,
  awsLogSubscriptionRoleArn,
  deleteAwsLogSubscription,
  describeAwsLogSubscriptionError,
  putAwsLogDestinationPolicy,
  putAwsLogSubscription,
  regionFromAwsLogSubscriptionPolicyName,
} from "./aws-log-subscriptions.js";

const environment = {
  AWS_CLOUDWATCH_LOGS_INGEST_TOKEN: "cell-secret",
  AWS_LOG_DESTINATION_NAME: "superlog-logs-eu",
  AWS_LOG_DESTINATION_REGIONS: "eu-west-1, us-east-1,eu-west-3,not-a-region",
  AWS_LOG_SUBSCRIPTION_PRINCIPAL_ARN: "arn:aws:iam::121638211609:role/ResponderLogSubscriptionBroker",
};
const config = awsLogSubscriptionConfig(environment)!;
const credentials = {
  accessKeyId: "AKIA",
  expiration: new Date("2026-11-09T12:00:00Z"),
  secretAccessKey: "secret",
  sessionToken: "token",
};
const stsCredentials = {
  AccessKeyId: "AKIA",
  Expiration: new Date("2026-11-09T12:00:00Z"),
  SecretAccessKey: "secret",
  SessionToken: "token",
};

function fakeLogs() {
  const sent: Array<{ command: unknown; credentials: unknown; region: string }> = [];
  const send = vi.fn();
  const factory = (region: string, given?: unknown) => ({
    send: (command: unknown) => {
      sent.push({ command, credentials: given, region });
      return send(command);
    },
  }) as never;
  return { factory, send, sent };
}

describe("AWS log subscription settings", () => {
  it("reads the infrastructure's settings and offers only real regions, in list order", () => {
    expect(config).toEqual({
      acceptsLogs: true,
      destinationAccountId: "121638211609",
      destinationName: "superlog-logs-eu",
      principalArn: environment.AWS_LOG_SUBSCRIPTION_PRINCIPAL_ARN,
      regions: ["us-east-1", "eu-west-1", "eu-west-3"],
    });
  });

  it("offers no log streaming when a setting is missing or invalid", () => {
    expect(awsLogSubscriptionConfig({})).toBeNull();
    expect(awsLogSubscriptionConfig({ ...environment, AWS_LOG_DESTINATION_REGIONS: "" })).toBeNull();
    expect(awsLogSubscriptionConfig({ ...environment, AWS_LOG_SUBSCRIPTION_PRINCIPAL_ARN: "role" })).toBeNull();
    expect(awsLogSubscriptionConfig({ ...environment, AWS_LOG_DESTINATION_NAME: "bad name" })).toBeNull();
    // Without the ingest token, nothing new is offered, but existing
    // subscriptions can still be removed.
    expect(awsLogSubscriptionConfig({ ...environment, AWS_CLOUDWATCH_LOGS_INGEST_TOKEN: " " })).toMatchObject({ acceptsLogs: false, regions: config.regions });
    expect(awsLogSubscriptionPrincipalArnForStacks({ ...environment, AWS_CLOUDWATCH_LOGS_INGEST_TOKEN: "" })).toBeNull();
    expect(awsLogSubscriptionPrincipalArnForStacks(environment)).toBe(environment.AWS_LOG_SUBSCRIPTION_PRINCIPAL_ARN);
  });

  it("names the customer's role, the destination, and the policy", () => {
    expect(awsLogSubscriptionRoleArn("123456789012")).toBe("arn:aws:iam::123456789012:role/ResponderLogSubscriptionRole");
    expect(awsLogDestinationArn(config, "eu-west-1")).toBe("arn:aws:logs:eu-west-1:121638211609:destination:superlog-logs-eu");
    expect(awsLogSubscriptionPolicyName("eu-west-1")).toBe("superlog-eu-west-1");
    expect(regionFromAwsLogSubscriptionPolicyName("superlog-eu-west-1")).toBe("eu-west-1");
    expect(regionFromAwsLogSubscriptionPolicyName("superlog-moon-1")).toBeNull();
    expect(regionFromAwsLogSubscriptionPolicyName("datadog-eu-west-1")).toBeNull();
  });
});

describe("assuming the customer's log subscription role", () => {
  it("goes through the broker and passes the connection's external ID", async () => {
    const calls: Array<{ input: unknown; withCredentials: boolean }> = [];
    const sts = (given?: unknown) => ({
      send: async (command: AssumeRoleCommand) => {
        calls.push({ input: command.input, withCredentials: Boolean(given) });
        return { Credentials: stsCredentials };
      },
    }) as never;
    await assumeAwsLogSubscriptionRole({ accountId: "123456789012", externalId: "responder_external" }, { config, sessionName: "test", sts });
    expect(calls).toEqual([
      { input: expect.objectContaining({ RoleArn: config.principalArn }), withCredentials: false },
      {
        input: expect.objectContaining({
          ExternalId: "responder_external",
          RoleArn: "arn:aws:iam::123456789012:role/ResponderLogSubscriptionRole",
        }),
        withCredentials: true,
      },
    ]);
  });

  it("reports a customer role that cannot be assumed as missing", async () => {
    let call = 0;
    const sts = () => ({
      send: async () => {
        call += 1;
        if (call === 2) throw Object.assign(new Error("not authorized to perform: sts:AssumeRole"), { name: "AccessDenied" });
        return { Credentials: stsCredentials };
      },
    }) as never;
    const failure = assumeAwsLogSubscriptionRole({ accountId: "123456789012", externalId: "responder_external" }, { config, sts });
    await expect(failure).rejects.toBeInstanceOf(AwsLogSubscriptionRoleUnavailableError);
    expect(describeAwsLogSubscriptionError(await failure.catch((error: unknown) => error), "eu-west-1").problem).toBe("role_missing");
  });

  it("passes other failures through, so they are retried rather than treated as a missing role", async () => {
    let call = 0;
    const sts = () => ({
      send: async () => {
        call += 1;
        if (call === 2) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
        return { Credentials: stsCredentials };
      },
    }) as never;
    const failure = assumeAwsLogSubscriptionRole({ accountId: "123456789012", externalId: "responder_external" }, { config, sts });
    await expect(failure).rejects.toThrow("Rate exceeded");
    await expect(failure).rejects.not.toBeInstanceOf(AwsLogSubscriptionRoleUnavailableError);
  });
});

describe("CloudWatch Logs calls", () => {
  it("creates the region's account-level subscription to Superlog's destination", async () => {
    const logs = fakeLogs();
    await putAwsLogSubscription({ config, credentials, filterPattern: awsLogSubscriptionFilterPattern, logs: logs.factory, region: "eu-west-1" });
    const { command, credentials: used, region } = logs.sent[0]!;
    expect(region).toBe("eu-west-1");
    expect(used).toBe(credentials);
    expect(command).toBeInstanceOf(PutAccountPolicyCommand);
    const input = (command as PutAccountPolicyCommand).input;
    expect(input).toMatchObject({ policyName: "superlog-eu-west-1", policyType: "SUBSCRIPTION_FILTER_POLICY", scope: "ALL" });
    expect(JSON.parse(input.policyDocument!)).toEqual({
      DestinationArn: "arn:aws:logs:eu-west-1:121638211609:destination:superlog-logs-eu",
      Distribution: "Random",
      FilterPattern: awsLogSubscriptionFilterPattern,
    });
    // A cross-account destination needs no role, so none is passed.
    expect(input.policyDocument).not.toContain("RoleArn");
  });

  it("deletes only Superlog's policy, and treats a missing one as deleted", async () => {
    const logs = fakeLogs();
    logs.send.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));
    await deleteAwsLogSubscription({ credentials, logs: logs.factory, region: "us-east-1" });
    const command = logs.sent[0]!.command as DeleteAccountPolicyCommand;
    expect(command).toBeInstanceOf(DeleteAccountPolicyCommand);
    expect(command.input).toEqual({ policyName: "superlog-us-east-1", policyType: "SUBSCRIPTION_FILTER_POLICY" });
    logs.send.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    await expect(deleteAwsLogSubscription({ credentials, logs: logs.factory, region: "us-east-1" })).rejects.toThrow("denied");
  });

  it("lets only connected accounts subscribe to a destination", async () => {
    expect(JSON.parse(awsLogDestinationPolicy(config, "eu-west-1", ["222233334444", "111122223333", "111122223333", "bad"]))).toEqual({
      Statement: [{
        Action: "logs:PutSubscriptionFilter",
        Effect: "Allow",
        Principal: { AWS: ["111122223333", "222233334444"] },
        Resource: "arn:aws:logs:eu-west-1:121638211609:destination:superlog-logs-eu",
        Sid: "SuperlogWorkspaces",
      }],
      Version: "2012-10-17",
    });
    // With no accounts, only Superlog's own account is listed.
    expect(JSON.parse(awsLogDestinationPolicy(config, "eu-west-1", [])).Statement[0].Principal).toEqual({ AWS: ["121638211609"] });
    const logs = fakeLogs();
    await putAwsLogDestinationPolicy({ accountIds: ["111122223333"], config, logs: logs.factory, region: "eu-west-1" });
    expect(logs.sent[0]!.credentials).toBeUndefined();
    expect(logs.sent[0]!.command).toBeInstanceOf(PutDestinationPolicyCommand);
    expect((logs.sent[0]!.command as PutDestinationPolicyCommand).input).toEqual({
      accessPolicy: awsLogDestinationPolicy(config, "eu-west-1", ["111122223333"]),
      destinationName: "superlog-logs-eu",
    });
  });
});

describe("describing failures", () => {
  it("explains an existing subscription, a denial, and anything else", () => {
    expect(describeAwsLogSubscriptionError(Object.assign(new Error("limit"), { name: "LimitExceededException" }), "eu-west-1")).toMatchObject({
      problem: "subscription_exists",
    });
    expect(describeAwsLogSubscriptionError(Object.assign(new Error("User is not authorized"), { name: "AccessDeniedException" }), "eu-west-1")).toMatchObject({
      problem: "access_denied",
    });
    const destination = "arn:aws:logs:eu-west-1:121638211609:destination:superlog-logs-eu";
    const refusedByDestination = Object.assign(new Error(`User is not authorized to perform: logs:PutSubscriptionFilter on resource: ${destination}`), { name: "AccessDeniedException" });
    expect(describeAwsLogSubscriptionError(refusedByDestination, "eu-west-1", destination).problem).toBe("destination_unavailable");
    // A denial in the customer's account that mentions some destination is
    // still the customer's to fix.
    const refusedByCustomer = Object.assign(new Error("not authorized on resource arn:aws:logs:eu-west-1:999988887777:destination:other"), { name: "AccessDeniedException" });
    expect(describeAwsLogSubscriptionError(refusedByCustomer, "eu-west-1", destination).problem).toBe("access_denied");
    expect(describeAwsLogSubscriptionError(new Error("boom"), "eu-west-1")).toEqual({
      message: "AWS returned an error in eu-west-1: boom",
      problem: "unknown",
    });
  });
});
