import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "../credentials/encryption.js";
import { getDatabase } from "../db/client.js";
import { sendEmail } from "../email.js";
import { notifyBillingLimitReached } from "./notifications.js";

vi.mock("../db/client.js", () => ({ getDatabase: vi.fn() }));
vi.mock("../email.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../email.js")>()),
  sendEmail: vi.fn().mockResolvedValue(true),
}));
vi.mock("../credentials/encryption.js", () => ({
  decryptCredentials: vi.fn(() => ({ accessToken: "xoxb-token" })),
}));

const organizationId = "20000000-0000-4000-8000-000000000000";

function query(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of [
    "from",
    "innerJoin",
    "where",
    "limit",
    "values",
    "onConflictDoNothing",
    "returning",
    "set",
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown[]) => void) => resolve(rows);
  return chain;
}

function databaseDouble(selects: unknown[][]) {
  const inserted: unknown[] = [];
  let deliveries = 0;
  const select = vi.fn();
  for (const rows of selects) select.mockReturnValueOnce(query(rows));
  select.mockImplementation(() => query([]));
  const insert = vi.fn(() => {
    const chain = query([{ id: `delivery-${++deliveries}` }]);
    chain.values = vi.fn((values: unknown) => {
      inserted.push(values);
      return chain;
    });
    return chain;
  });
  const statuses: unknown[] = [];
  const update = vi.fn(() => {
    const chain = query([]);
    chain.set = vi.fn((values: { status?: string }) => {
      statuses.push(values.status);
      return chain;
    });
    return chain;
  });
  vi.mocked(getDatabase).mockReturnValue({ insert, select, update } as never);
  return { inserted, statuses };
}

describe("billing notice delivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendEmail).mockResolvedValue(true);
    vi.stubEnv("CONTROL_PLANE_URL", "https://responder.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
    );
  });

  it("emails each admin once and messages the Slack installer", async () => {
    const { inserted } = databaseDouble([
      [{
        encryptedCredentials: "encrypted",
        id: "account-1",
        metadata: { connectedBySlackUserId: "U123" },
      }],
      // Enabled agents watching Slack channels.
      [],
      [{ email: "Ada@Example.com" }, { email: "ada@example.com" }, { email: "grace@example.com" }],
      // Slack channels the bot is a member of.
      [],
      [{ name: "Acme" }],
    ]);

    await notifyBillingLimitReached(organizationId, 1_800_000_000, { usageBased: true });

    expect(inserted).toEqual([
      {
        destination: "U123",
        integrationAccountId: "account-1",
        kind: "installer_dm",
        organizationId,
        periodKey: "reset:1800000000",
        usageBased: true,
      },
      {
        destination: "ada@example.com",
        integrationAccountId: null,
        kind: "email",
        organizationId,
        periodKey: "reset:1800000000",
        usageBased: true,
      },
      {
        destination: "grace@example.com",
        integrationAccountId: null,
        kind: "email",
        organizationId,
        periodKey: "reset:1800000000",
        usageBased: true,
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toMatchObject({
      channel: "U123",
      text: expect.stringContaining("paused new investigations and automation runs"),
    });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "billing-notice/delivery-2",
      subject: "Superlog paused new work in Acme",
      to: "ada@example.com",
    }));
  });

  it("sends nothing to a destination that already has this period's notice", async () => {
    databaseDouble([[], [], [{ email: "ada@example.com" }]]);
    const insert = vi.fn(() => query([]));
    vi.mocked(getDatabase)().insert = insert as never;
    vi.mocked(getDatabase)().update = vi.fn(() => query([])) as never;

    await notifyBillingLimitReached(organizationId, 1_800_000_000, { usageBased: true });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("still emails admins when a Slack account cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(decryptCredentials).mockImplementationOnce(() => {
      throw new Error("bad key");
    });
    databaseDouble([
      [{ encryptedCredentials: "encrypted", id: "account-1", metadata: {} }],
      [],
      [{ email: "ada@example.com" }],
      [{ name: "Acme" }],
    ]);

    await notifyBillingLimitReached(organizationId, 1_800_000_000, { usageBased: true });

    expect(fetch).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com" }));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("billing_notice_slack_account_unreadable"),
    );
  });

  it("retries a delivery it can reclaim and records it as sent", async () => {
    const { statuses } = databaseDouble([[], [], [{ email: "ada@example.com" }], [{ name: "Acme" }]]);
    vi.mocked(getDatabase)().insert = vi.fn(() => query([])) as never;
    const update = vi.mocked(getDatabase)().update as ReturnType<typeof vi.fn>;
    const recordStatus = update.getMockImplementation()!;
    update.mockImplementationOnce(() => {
      const chain = query([{ id: "delivery-retry" }]);
      chain.set = vi.fn(() => chain);
      return chain;
    });
    update.mockImplementation(recordStatus);

    await notifyBillingLimitReached(organizationId, 1_800_000_000, { usageBased: true });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "billing-notice/delivery-retry",
      to: "ada@example.com",
    }));
    expect(statuses).toEqual(["sent"]);
  });

  it("records and logs an email that was skipped as failed so it is retried", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(sendEmail).mockResolvedValue(false);
    const { statuses } = databaseDouble([[], [], [{ email: "ada@example.com" }], [{ name: "Acme" }]]);

    await notifyBillingLimitReached(organizationId, 1_800_000_000, { usageBased: true });

    expect(statuses).toEqual(["failed"]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("billing_notice_delivery_failed"));
  });
});
