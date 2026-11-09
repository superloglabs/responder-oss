import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AwsAccountStreamsElsewhereError,
  AwsLogSubscriptionConnectionError,
  type AwsLogSubscription,
} from "../../../../packages/core/src/db/aws-log-subscriptions.js";
import {
  AwsLogSubscriptionRoleUnavailableError,
  awsLogSubscriptionFilterPattern,
  type AwsLogSubscriptionConfig,
} from "../../../../packages/core/src/integrations/aws-log-subscriptions.js";
import { getActiveTenant } from "../tenant.js";
import {
  awsStackUpdateCommand,
  createAwsLogSubscriptionManager,
  createAwsLogSubscriptionRoutes,
  removeAwsLogSubscriptionsBeforeDisconnect,
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
const throttled = Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });

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
  const accounts = new Map([["eu-west-1", ["123456789012"]]]);
  const deps: AwsLogSubscriptionDependencies = {
    assume: vi.fn(async () => temporary),
    claim: vi.fn(async (ids: string[]) => ids.map((id) => row({ id, region: id.replace(/^row-/u, "") }))),
    claimDue: vi.fn(async () => [] as AwsLogSubscription[]),
    config: () => config,
    connection: vi.fn(async () => ({ credentials: connectionCredentials, status: "connected" })),
    deleteRow: vi.fn(async () => undefined),
    deleteSubscription: vi.fn(async () => undefined),
    destinationAccounts: vi.fn(async (region: string, write: (ids: string[]) => Promise<void>) => {
      const ids = accounts.get(region) ?? [];
      await write(ids);
      return ids;
    }),
    list: vi.fn(async () => [] as AwsLogSubscription[]),
    markActive: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    markRemovalFailed: vi.fn(async () => undefined),
    now: () => now,
    putDestinationPolicy: vi.fn(async () => undefined),
    putSubscription: vi.fn(async () => undefined),
    removeAll: vi.fn(async () => [] as AwsLogSubscription[]),
    setRegions: vi.fn(async () => [] as AwsLogSubscription[]),
    templateUrl: vi.fn(async () => null),
    topicArn: () => "arn:aws:sns:eu-west-3:121638211609:ResponderAwsRegistration",
    ...overrides,
  };
  return { advance: (ms: number) => { now += ms; }, deps };
}

describe("reconciling subscriptions", () => {
  it("lets each region's destination accept its accounts before applying, and skips unchanged lists", async () => {
    const { advance, deps } = dependencies({ claimDue: vi.fn(async () => [row()]) });
    const manager = createAwsLogSubscriptionManager(deps);
    await manager.reconcile();
    expect(vi.mocked(deps.putDestinationPolicy).mock.calls.map(([input]) => [input.region, input.accountIds])).toEqual([
      ["us-east-1", []],
      ["eu-west-1", ["123456789012"]],
    ]);
    expect(vi.mocked(deps.putDestinationPolicy).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(deps.putSubscription).mock.invocationCallOrder[0]!);
    expect(deps.claimDue).toHaveBeenCalledWith(expect.objectContaining({ filterPattern: awsLogSubscriptionFilterPattern, leaseMs: 300_000 }));
    expect(deps.putSubscription).toHaveBeenCalledWith(expect.objectContaining({ filterPattern: awsLogSubscriptionFilterPattern, region: "eu-west-1" }));
    expect(deps.markActive).toHaveBeenCalledWith("row-eu-west-1", awsLogSubscriptionFilterPattern);

    await manager.reconcile();
    expect(deps.putDestinationPolicy).toHaveBeenCalledTimes(2);
    expect(deps.destinationAccounts).toHaveBeenCalledTimes(4);
    advance(16 * 60_000);
    await manager.reconcile();
    expect(deps.putDestinationPolicy).toHaveBeenCalledTimes(4);
  });

  it("records why a subscription failed", async () => {
    const { deps } = dependencies({
      claimDue: vi.fn(async () => [row()]),
      putSubscription: vi.fn(async () => { throw Object.assign(new Error("limit"), { name: "LimitExceededException" }); }),
    });
    await createAwsLogSubscriptionManager(deps).reconcile();
    expect(deps.markFailed).toHaveBeenCalledWith("row-eu-west-1", expect.stringContaining("AWS allows one per account and region"));
  });

  it("asks for a stack update when the role cannot be assumed", async () => {
    const { deps } = dependencies({
      assume: vi.fn(async () => { throw new AwsLogSubscriptionRoleUnavailableError(new Error("denied")); }),
      claimDue: vi.fn(async () => [row(), row({ id: "row-us-east-1", region: "us-east-1" })]),
    });
    await createAwsLogSubscriptionManager(deps).reconcile();
    expect(deps.assume).toHaveBeenCalledTimes(1);
    expect(deps.markFailed).toHaveBeenCalledTimes(2);
    expect(deps.markFailed).toHaveBeenCalledWith("row-us-east-1", expect.stringContaining("ResponderLogSubscriptionRole"));
    expect(deps.putSubscription).not.toHaveBeenCalled();
  });

  it("deletes removed regions' policies, retries transient failures, and forgets them only when the role is gone", async () => {
    const removing = row({ status: "removing" });
    const ok = dependencies({ claimDue: vi.fn(async () => [removing]) });
    await createAwsLogSubscriptionManager(ok.deps).reconcile();
    expect(ok.deps.deleteSubscription).toHaveBeenCalledWith({ credentials: temporary, region: "eu-west-1" });
    expect(ok.deps.deleteRow).toHaveBeenCalledWith(removing.id);

    const failing = dependencies({ claimDue: vi.fn(async () => [removing]), deleteSubscription: vi.fn(async () => { throw throttled; }) });
    await createAwsLogSubscriptionManager(failing.deps).reconcile();
    expect(failing.deps.deleteRow).not.toHaveBeenCalled();
    expect(failing.deps.markRemovalFailed).toHaveBeenCalled();

    const assumeThrottled = dependencies({ assume: vi.fn(async () => { throw throttled; }), claimDue: vi.fn(async () => [removing]) });
    await createAwsLogSubscriptionManager(assumeThrottled.deps).reconcile();
    expect(assumeThrottled.deps.deleteRow).not.toHaveBeenCalled();
    expect(assumeThrottled.deps.markRemovalFailed).toHaveBeenCalledWith(removing.id, expect.stringContaining("Rate exceeded"));

    const roleGone = dependencies({
      assume: vi.fn(async () => { throw new AwsLogSubscriptionRoleUnavailableError(new Error("denied")); }),
      claimDue: vi.fn(async () => [removing]),
    });
    await createAwsLogSubscriptionManager(roleGone.deps).reconcile();
    expect(roleGone.deps.deleteSubscription).not.toHaveBeenCalled();
    expect(roleGone.deps.deleteRow).toHaveBeenCalledWith(removing.id);
  });

  it("does nothing without log streaming settings", async () => {
    const { deps } = dependencies({ config: () => null });
    await createAwsLogSubscriptionManager(deps).reconcile();
    expect(deps.claimDue).not.toHaveBeenCalled();
    expect(deps.putDestinationPolicy).not.toHaveBeenCalled();
  });
});

describe("removing an AWS connection", () => {
  const input = { integrationAccountId, organizationId };
  const both = () => [row({ status: "removing" }), row({ id: "row-us-east-1", region: "us-east-1", status: "removing" })];

  it("deletes every policy before the connection goes", async () => {
    const { deps } = dependencies({ removeAll: vi.fn(async () => both()) });
    expect(await removeAwsLogSubscriptionsBeforeDisconnect(input, deps)).toEqual({ left: [], ok: true });
    expect(vi.mocked(deps.deleteSubscription).mock.calls.map(([call]) => call.region)).toEqual(["eu-west-1", "us-east-1"]);
    expect(deps.deleteRow).toHaveBeenCalledTimes(2);
    expect(deps.destinationAccounts).toHaveBeenCalled();
  });

  it("blocks the removal and keeps retrying when a policy cannot be deleted", async () => {
    const { deps } = dependencies({
      deleteSubscription: vi.fn(async ({ region }: { region: string }) => { if (region === "us-east-1") throw throttled; }),
      removeAll: vi.fn(async () => both()),
    });
    const result = await removeAwsLogSubscriptionsBeforeDisconnect(input, deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("us-east-1") });
    expect(deps.deleteRow).toHaveBeenCalledTimes(1);
    expect(deps.markRemovalFailed).toHaveBeenCalledWith("row-us-east-1", expect.any(String));

    const assumeFails = dependencies({ assume: vi.fn(async () => { throw throttled; }), removeAll: vi.fn(async () => both()) });
    expect(await removeAwsLogSubscriptionsBeforeDisconnect(input, assumeFails.deps)).toMatchObject({ ok: false });
    expect(assumeFails.deps.deleteRow).not.toHaveBeenCalled();
  });

  it("lets the removal go ahead when the role is already gone, and names what is left", async () => {
    const { deps } = dependencies({
      assume: vi.fn(async () => { throw new AwsLogSubscriptionRoleUnavailableError(new Error("denied")); }),
      removeAll: vi.fn(async () => both()),
    });
    expect(await removeAwsLogSubscriptionsBeforeDisconnect(input, deps)).toEqual({ left: ["eu-west-1", "us-east-1"], ok: true });
    expect(deps.deleteRow).toHaveBeenCalledTimes(2);
  });

  it("waits for another process that is working on the rows", async () => {
    const { deps } = dependencies({ claim: vi.fn(async () => [row({ status: "removing" })]), removeAll: vi.fn(async () => both()) });
    expect(await removeAwsLogSubscriptionsBeforeDisconnect(input, deps)).toMatchObject({ ok: false, error: expect.stringContaining("Try again") });
    expect(deps.deleteSubscription).not.toHaveBeenCalled();
  });

  it("has nothing to do without subscriptions or settings", async () => {
    expect(await removeAwsLogSubscriptionsBeforeDisconnect(input, dependencies().deps)).toEqual({ left: [], ok: true });
    expect(await removeAwsLogSubscriptionsBeforeDisconnect(input, dependencies({ config: () => null }).deps)).toEqual({ left: [], ok: true });
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
    expect(await response.json()).toMatchObject({ available: false, canManage: false });
  });

  it("lists region statuses for a connection in the workspace, and who may change them", async () => {
    const { deps } = dependencies({ list: vi.fn(async () => [row({ appliedAt: new Date("2026-11-09T10:00:00Z"), status: "active" })]) });
    const response = await app(deps).request(`/api/integrations/aws/log-subscriptions/${integrationAccountId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      canManage: true,
      regions: ["us-east-1", "eu-west-1"],
      stackUpdate: null,
      subscriptions: [{ appliedAt: "2026-11-09T10:00:00.000Z", lastError: null, region: "eu-west-1", status: "active" }],
    });
    vi.mocked(getActiveTenant).mockResolvedValueOnce({ ok: true, organizationId, role: "member", user: { email: "m@example.com", id: "user-2", name: "M" } });
    expect(await (await app(deps).request(`/api/integrations/aws/log-subscriptions/${integrationAccountId}`)).json()).toMatchObject({ canManage: false });
    const missing = dependencies({ connection: vi.fn(async () => null) });
    expect((await app(missing.deps).request(`/api/integrations/aws/log-subscriptions/${integrationAccountId}`)).status).toBe(404);
  });

  it("saves regions and applies the rows it can claim at once", async () => {
    const saved = [row(), row({ appliedAt: new Date(), id: "row-us-east-1", region: "us-east-1", status: "active" })];
    const { deps } = dependencies({ list: vi.fn(async () => saved), setRegions: vi.fn(async () => saved) });
    const response = await put(app(deps), ["eu-west-1", "us-east-1"]);
    expect(response.status).toBe(200);
    expect(deps.setRegions).toHaveBeenCalledWith({
      awsAccountId: "123456789012",
      filterPattern: awsLogSubscriptionFilterPattern,
      integrationAccountId,
      organizationId,
      regions: ["eu-west-1", "us-east-1"],
    });
    // The active row with the current filter needs no work.
    expect(deps.claim).toHaveBeenCalledWith(["row-eu-west-1"], 300_000);
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

  it("refuses members, unknown regions, unfinished or foreign connections, and accounts streaming elsewhere", async () => {
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
    const foreign = dependencies({ setRegions: vi.fn(async () => { throw new AwsLogSubscriptionConnectionError(); }) });
    expect((await put(app(foreign.deps), ["eu-west-1"])).status).toBe(404);
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
