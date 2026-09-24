import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  encryptCredentials,
  decryptCredentials,
} from "../credentials/encryption.js";
import { getDatabase } from "./client.js";
const transport = { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() };
import {
  startModelSubscription,
  pollModelSubscription,
  cancelModelSubscription,
} from "./model-subscriptions.js";
vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));
const owner = {
  organizationId: "15151515-1515-4515-8515-151515151515",
  userId: "21212121-2121-4121-8121-212121212121",
};
const connectionId = "41414141-4141-4141-8141-414141414141";
const device = {
  sandboxId: "sandbox-secret",
  userCode: "ABCD-EFGH",
  verificationUrl: "https://auth.openai.com/codex/device",
};
function database(row: unknown) {
  const lock = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ for: lock });
  const returning = vi.fn().mockResolvedValue([{ id: "credential-id" }]);
  const values = vi
    .fn()
    .mockReturnValue({ returning, onConflictDoUpdate: () => ({ returning }) });
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  const remove = vi.fn().mockResolvedValue([]);
  const tx = {
    execute: vi.fn(),
    delete: () => ({ where: remove }),
    select: () => ({ from: () => ({ where }) }),
    insert: () => ({ values }),
    update: () => ({ set }),
  };
  vi.mocked(getDatabase).mockReturnValue({
    transaction: async (callback: (db: unknown) => Promise<unknown>) =>
      callback(tx),
  } as never);
  return { lock, where, values, set, remove };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
describe("subscription connection storage", () => {
  it("stores encrypted login state and exposes only the user code", async () => {
    vi.stubEnv(
      "CREDENTIAL_ENCRYPTION_KEY",
      Buffer.alloc(32, 1).toString("base64"),
    );
    transport.start.mockResolvedValue(device);
    const { values } = database(null);
    const result = await startModelSubscription(owner, transport);
    expect(result).not.toHaveProperty("sandboxId");
    expect(result.userCode).toBe(device.userCode);
    const stored = values.mock.calls[0][0];
    expect(stored.encryptedState).not.toContain(device.sandboxId);
    expect(decryptCredentials(stored.encryptedState)).toEqual(device);
  });
  it.each([null])(
    "rejects missing or expired state without contacting the provider",
    async (row) => {
      const db = database(row);
      await expect(
        pollModelSubscription({ ...owner, connectionId }, transport),
      ).resolves.toEqual({ status: "expired" });
      expect(transport.poll).not.toHaveBeenCalled();
      const query = new PgDialect().sqlToQuery(db.where.mock.calls[0][0]);
      expect(query.params).toEqual([
        connectionId,
        owner.organizationId,
        owner.userId,
      ]);
      expect(db.lock).toHaveBeenCalledWith("update");
    },
  );
  it("does not poll before the provider's interval or duplicate completed credentials", async () => {
    database({
      expiresAt: new Date(Date.now() + 60000),
      nextPollAt: new Date(Date.now() + 60000),
    });
    await expect(
      pollModelSubscription({ ...owner, connectionId }, transport),
    ).resolves.toEqual({ status: "pending" });
    database({
      expiresAt: new Date(Date.now() + 60000),
      credentialId: "existing",
    });
    await expect(
      pollModelSubscription({ ...owner, connectionId }, transport),
    ).resolves.toEqual({ status: "connected", credentialId: "existing" });
    expect(transport.poll).not.toHaveBeenCalled();
  });
  it("persists encrypted tokens once and erases the device secret on completion", async () => {
    vi.stubEnv(
      "CREDENTIAL_ENCRYPTION_KEY",
      Buffer.alloc(32, 1).toString("base64"),
    );
    const tokens = {
      authJson: JSON.stringify({
        tokens: {
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          id_token: "id-token",
          account_id: "account",
        },
      }),
    };
    transport.poll.mockResolvedValue({ status: "connected", ...tokens });
    const db = database({
      id: connectionId,
      expiresAt: new Date(Date.now() + 60000),
      nextPollAt: new Date(0),
      encryptedState: encryptCredentials(device),
    });
    await expect(
      pollModelSubscription({ ...owner, connectionId }, transport),
    ).resolves.toEqual({ status: "connected", credentialId: "credential-id" });
    const stored = db.values.mock.calls[0][0];
    expect(stored.authType).toBe("chatgpt_subscription");
    expect(decryptCredentials(stored.encryptedCredentials)).toEqual(tokens);
    expect(db.set).toHaveBeenCalledWith({ credentialId: "credential-id" });
  });
});

const oldState = () => ({
  id: connectionId,
  encryptedState: encryptCredentials(device),
  expiresAt: new Date(0),
});
it("cleans expired login state before deleting the row", async () => {
  vi.stubEnv(
    "CREDENTIAL_ENCRYPTION_KEY",
    Buffer.alloc(32, 1).toString("base64"),
  );
  const db = database(oldState());
  await expect(
    pollModelSubscription({ ...owner, connectionId }, transport),
  ).resolves.toEqual({ status: "expired" });
  expect(transport.cancel).toHaveBeenCalledWith(device.sandboxId);
  expect(db.remove).toHaveBeenCalled();
});
it("retains cancellation state when cleanup fails", async () => {
  vi.stubEnv(
    "CREDENTIAL_ENCRYPTION_KEY",
    Buffer.alloc(32, 1).toString("base64"),
  );
  const db = database(oldState());
  transport.cancel.mockRejectedValueOnce(new Error("temporary failure"));
  await expect(
    cancelModelSubscription({ ...owner, connectionId }, transport),
  ).rejects.toThrow("temporary failure");
  expect(db.remove).not.toHaveBeenCalled();
});
it("cancels the prior login before starting its replacement", async () => {
  vi.stubEnv(
    "CREDENTIAL_ENCRYPTION_KEY",
    Buffer.alloc(32, 1).toString("base64"),
  );
  database(oldState());
  transport.start.mockImplementationOnce(async () => {
    expect(transport.cancel).toHaveBeenCalledWith(device.sandboxId);
    return device;
  });
  await startModelSubscription(owner, transport);
});
