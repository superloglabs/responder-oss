import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AwsAccountStreamsElsewhereError, type AwsLogSubscription } from "../../../../packages/core/src/db/aws-log-subscriptions.js";
import {
  AwsLogSubscriptionRoleUnavailableError,
  awsLogSubscriptionFilterPattern,
  type AwsLogSubscriptionConfig,
} from "../../../../packages/core/src/integrations/aws-log-subscriptions.js";
import { getActiveTenant } from "../tenant.js";
import {
  awsLogSubscriptionCleanup,
  awsStackUpdateCommand,
  createAwsLogSubscriptionManager,
  createAwsLogSubscriptionRoutes,
  type AwsLogSubscriptionDependencies,
} from "./aws-log-subscriptions.js";

vi.mock("../tenant.js", () => ({ getActiveTenant: vi.fn() }));

const organizationId = "22222222-2222-4222-8222-222222222222";
const integrationAccountId = "33333333-3333-4333-8333-333333333333";
const config: AwsLogSubscriptionConfig = {
  destinationAccountId: "121638211609",
  destinationName: "superlog-logs-eu",
  principalArn: "arn:aws:iam::121638211609:role/ResponderLogSubscriptionBroker",
  regions: ["us-east-1", "eu-west-1"],
};
const connectionCredentials = {
  accountId: "123456789012",
  externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
  roleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole",
};
const temporary = { accessKeyId: "AKIA", expiration: new Date(), secretAccessKey: "s", sessionToken: "t" };

function row(overrides: Partial<AwsLogSubscription> = {}): AwsLogSubscription {
  return {
    appliedAt: null,
    awsAccountId: "123456789012",
    filterPattern: awsLogSubscriptionFilterPattern,
    id: `row-${overrides.region ?? "eu-west-1"}`,
    integrationAccountId,
    lastError: null,
    organizationId,
    region: "eu-west-1",
    status: "pending",
    updatedAt: new Date(),
    ...overrides,
  };
}

function dependencies(overrides: Partial<AwsLogSubscriptionDependencies> = {}) {
  let now = 1_000_000;
  const deps = {
    assume: vi.fn(async () => temporary),
    config: () => config,
    connection: vi.fn(async () => ({ credentials: connectionCredentials, status: "connected" })),
    deleteRow: vi.fn(async () => undefined),
    deleteSubscription: vi.fn(async () => undefined),
    due: vi.fn(async () => [] as AwsLogSubscription[]),
    list: vi.fn(async () => [] as AwsLogSubscription[]),
    markActive: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    markRemovalFailed: vi.fn(async () => undefined),
    now: () => now,
    putDestinationPolicy: vi.fn(async () => undefined),
    putSubscription: vi.fn(async () => undefined),
    regionAccounts: vi.fn(async () => new Map([["eu-west-1", ["123456789012"]]])),
    setRegions: vi.fn(async () => [] as AwsLogSubscription[]),
    templateUrl: vi.fn(async () => null),
    topicArn: () => "arn:aws:sns:eu-west-3:121638211609:ResponderAwsRegistration",
    ...overrides,
  } satisfies AwsLogSubscriptionDependencies;
  return { advance: (ms: number) => { now += ms; }, deps };
}

describe("reconciling subscriptions", () => {
  it("lets each region's destination accept its accounts before applying, and skips unchanged lists", async () => {
    const { advance, deps } = dependencies({ due: vi.fn(async () => [row()]) });
    const manager = createAwsLogSubscriptionManager(deps);
    await manager.reconcile();
    expect(vi.mocked(deps.putDestinationPolicy).mock.calls.map(([input]) => [input.region, input.accountIds])).toEqual([
      ["us-east-1", []],
      ["eu-west-1", ["123456789012"]],
    ]);
    expect(vi.mocked(deps.putDestinationPolicy).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(deps.putSubscription).mock.invocationCallOrder[0]!);
    expect(deps.putSubscription).toHaveBeenCalledWith(expect.objectContaining({ filterPattern: awsLogSubscriptionFilterPattern, region: "eu-west-1" }));
    expect(deps.markActive).toHaveBeenCalledWith("row-eu-west-1", awsLogSubscriptionFilterPattern);

    await manager.reconcile();
    expect(deps.putDestinationPolicy).toHaveBeenCalledTimes(2);
    advance(16 * 60_000);
    await manager.reconcile();
    expect(deps.putDestinationPolicy).toHaveBeenCalledTimes(4);
  });

  it("records why a subscription failed", async () => {
    const { deps } = dependencies({
      due: vi.fn(async () => [row()]),
      putSubscription: vi.fn(async () => { throw Object.assign(new Error("limit"), { name: "LimitExceededException" }); }),
    });
    await createAwsLogSubscriptionManager(deps).reconcile();
    expect(deps.markFailed).toHaveBeenCalledWith("row-eu-west-1", expect.stringContaining("already has an account-level log subscription"));
  });

  it("asks for a stack update when the role cannot be assumed", async () => {
    const { deps } = dependencies({
      assume: vi.fn(async () => { throw new AwsLogSubscriptionRoleUnavailableError(new Error("denied")); }),
      due: vi.fn(async () => [row(), row({ id: "row-us-east-1", region: "us-east-1" })]),
    });
    await createAwsLogSubscriptionManager(deps).reconcile();
    expect(deps.assume).toHaveBeenCalledTimes(1);
    expect(deps.markFailed).toHaveBeenCalledTimes(2);
    expect(deps.markFailed).toHaveBeenCalledWith("row-us-east-1", expect.stringContaining("ResponderLogSubscriptionRole"));
    expect(deps.putSubscription).not.toHaveBeenCalled();
  });

  it("deletes removed regions' policies, and forgets them when the role is gone", async () => {
    const removing = row({ status: "removing" });
    const ok = dependencies({ due: vi.fn(async () => [removing]) });
    await createAwsLogSubscriptionManager(ok.deps).reconcile();
    expect(ok.deps.deleteSubscription).toHaveBeenCalledWith({ credentials: temporary, region: "eu-west-1" });
    expect(ok.deps.deleteRow).toHaveBeenCalledWith(removing.id);

    const failing = dependencies({
      deleteSubscription: vi.fn(async () => { throw new Error("throttled"); }),
      due: vi.fn(async () => [removing]),
    });
    await createAwsLogSubscriptionManager(failing.deps).reconcile();
    expect(failing.deps.deleteRow).not.toHaveBeenCalled();
    expect(failing.deps.markRemovalFailed).toHaveBeenCalled();

    const roleGone = dependencies({
      assume: vi.fn(async () => { throw new AwsLogSubscriptionRoleUnavailableError(new Error("denied")); }),
      due: vi.fn(async () => [removing]),
    });
    await createAwsLogSubscriptionManager(roleGone.deps).reconcile();
    expect(roleGone.deps.deleteSubscription).not.toHaveBeenCalled();
    expect(roleGone.deps.deleteRow).toHaveBeenCalledWith(removing.id);
  });

  it("does nothing without log streaming settings", async () => {
    const { deps } = dependencies({ config: () => null });
    await createAwsLogSubscriptionManager(deps).reconcile();
    expect(deps.due).not.toHaveBeenCalled();
    expect(deps.putDestinationPolicy).not.toHaveBeenCalled();
  });

  it("deletes a removed connection's policies with the credentials read before", async () => {
    const { deps } = dependencies({ list: vi.fn(async () => [row(), row({ id: "row-us-east-1", region: "us-east-1" })]) });
    const cleanup = await awsLogSubscriptionCleanup({ integrationAccountId, organizationId }, deps);
    expect(cleanup).not.toBeNull();
    await cleanup!();
    expect(vi.mocked(deps.deleteSubscription).mock.calls.map(([input]) => input.region)).toEqual(["eu-west-1", "us-east-1"]);
    const none = dependencies();
    expect(await awsLogSubscriptionCleanup({ integrationAccountId, organizationId }, none.deps)).toBeNull();
  });
});

describe("log subscription routes", () => {
  beforeEach(() => {
    vi.mocked(getActiveTenant).mockResolvedValue({
      ok: true,
      organizationId,
      role: "admin",
      user: { email: "a@example.com", id: "user-1", name: "A" },
    });
  });

  function app(deps: AwsLogSubscriptionDependencies) {
    return new Hono().route("/api/integrations/aws/log-subscriptions", createAwsLogSubscriptionRoutes(deps));
  }
  const put = (target: Hono, regions: unknown) => target.request(`/api/integrations/aws/log-subscriptions/${integrationAccountId}`, {
    body: JSON.stringify({ regions }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });

  it("says when log streaming is not available here", async () => {
    const { deps } = dependencies({ config: () => null });
    const response = await app(deps).request(`/api/integrations/aws/log-subscriptions/${integrationAccountId}`);
    expect(await response.json()).toMatchObject({ available: false });
  });

  it("lists region statuses for a connection in the workspace", async () => {
    const { deps } = dependencies({ list: vi.fn(async () => [row({ appliedAt: new Date("2026-11-09T10:00:00Z"), status: "active" })]) });
    const response = await app(deps).request(`/api/integrations/aws/log-subscriptions/${integrationAccountId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      regions: ["us-east-1", "eu-west-1"],
      stackUpdate: null,
      subscriptions: [{ appliedAt: "2026-11-09T10:00:00.000Z", lastError: null, region: "eu-west-1", status: "active" }],
    });
    const missing = dependencies({ connection: vi.fn(async () => null) });
    expect((await app(missing.deps).request(`/api/integrations/aws/log-subscriptions/${integrationAccountId}`)).status).toBe(404);
  });

  it("saves regions and applies them at once", async () => {
    const saved = [row()];
    const { deps } = dependencies({ list: vi.fn(async () => saved), setRegions: vi.fn(async () => saved) });
    const response = await put(app(deps), ["eu-west-1"]);
    expect(response.status).toBe(200);
    expect(deps.setRegions).toHaveBeenCalledWith({
      awsAccountId: "123456789012",
      filterPattern: awsLogSubscriptionFilterPattern,
      integrationAccountId,
      organizationId,
      regions: ["eu-west-1"],
    });
    expect(deps.putSubscription).toHaveBeenCalledTimes(1);
  });

  it("shows the stack update when the role is missing", async () => {
    const failed = [row({ lastError: new AwsLogSubscriptionRoleUnavailableError(null).message, status: "failed" })];
    const { deps } = dependencies({ list: vi.fn(async () => failed), templateUrl: vi.fn(async () => "https://bucket.s3.eu-west-3.amazonaws.com/t.yaml?X-Amz-Signature=x") });
    const body = await (await app(deps).request(`/api/integrations/aws/log-subscriptions/${integrationAccountId}`)).json() as {
      stackUpdate: { command: string; stackName: string };
    };
    expect(body.stackUpdate.stackName).toBe("ResponderInvestigationAccess");
    expect(body.stackUpdate.command).toContain("--region eu-west-3");
    expect(body.stackUpdate.command).toContain("ParameterKey=ExternalId,UsePreviousValue=true");
    expect(body.stackUpdate.command).toContain(`ParameterKey=LogSubscriptionPrincipalArn,ParameterValue=${config.principalArn}`);
  });

  it("refuses members, unknown regions, unfinished connections, and accounts streaming elsewhere", async () => {
    const { deps } = dependencies();
    vi.mocked(getActiveTenant).mockResolvedValueOnce({ ok: true, organizationId, role: "member", user: { email: "m@example.com", id: "user-2", name: "M" } });
    expect((await put(app(deps), ["eu-west-1"])).status).toBe(403);
    expect((await put(app(deps), ["eu-central-1"])).status).toBe(400);
    expect((await put(app(deps), "eu-west-1")).status).toBe(400);
    const pending = dependencies({ connection: vi.fn(async () => ({ credentials: connectionCredentials, status: "pending" })) });
    expect((await put(app(pending.deps), ["eu-west-1"])).status).toBe(409);
    const elsewhere = dependencies({ setRegions: vi.fn(async () => { throw new AwsAccountStreamsElsewhereError(); }) });
    const response = await put(app(elsewhere.deps), ["eu-west-1"]);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This AWS account already streams its logs to another Superlog workspace" });
    expect(deps.setRegions).not.toHaveBeenCalled();
  });
});

describe("stack update command", () => {
  it("keeps every other parameter and works without a template URL", () => {
    expect(awsStackUpdateCommand({ logSubscriptionPrincipalArn: config.principalArn, region: null, templateUrl: null })).toBe(
      "aws cloudformation update-stack --stack-name ResponderInvestigationAccess --template-body file://responder-aws-access.yaml --capabilities CAPABILITY_NAMED_IAM --parameters ParameterKey=ResponderPrincipalArn,UsePreviousValue=true ParameterKey=ExternalId,UsePreviousValue=true ParameterKey=RegistrationTopicArn,UsePreviousValue=true ParameterKey=LogSubscriptionPrincipalArn,ParameterValue=arn:aws:iam::121638211609:role/ResponderLogSubscriptionBroker",
    );
  });
});
