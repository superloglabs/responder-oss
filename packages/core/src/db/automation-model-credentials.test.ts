import { afterEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  acquireSubscriptionCredential,
  chooseOrganizationModelCredential,
  selectOrganizationModelCredential,
  persistSubscriptionCredential,
  releaseSubscriptionCredential,
  SubscriptionCredentialUnavailableError,
} from "./automation-model-credentials.js";
import { getDatabase } from "./client.js";
import {
  decryptCredentials,
  encryptCredentials,
} from "../credentials/encryption.js";
vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
const authJson = JSON.stringify({
  tokens: {
    id_token: "id",
    access_token: "access",
    refresh_token: "refresh",
    account_id: "account",
  },
});
const owner = {
  credentialId: "credential",
  organizationId: "organization",
  leaseId: "lease",
};
it("acquires an exclusive scoped lease before exposing the native credential", async () => {
  vi.stubEnv(
    "CREDENTIAL_ENCRYPTION_KEY",
    Buffer.alloc(32, 1).toString("base64"),
  );
  const returning = vi
    .fn()
    .mockResolvedValue([
      { encryptedCredentials: encryptCredentials({ authJson }) },
    ]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(getDatabase).mockReturnValue({ update: () => ({ set }), transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ update: () => ({ set }) }) } as never);
  await expect(
    acquireSubscriptionCredential({
      ...owner,
      expiresAt: new Date(Date.now() + 60000),
    }),
  ).resolves.toBe(authJson);
  expect(set).toHaveBeenCalledWith({
    subscriptionLeaseId: owner.leaseId,
    subscriptionLeaseExpiresAt: expect.any(Date),
  });
  expect(new PgDialect().sqlToQuery(where.mock.calls[0][0]).sql).not.toContain(
    " or ",
  );
  expect(new PgDialect().sqlToQuery(where.mock.calls[0][0]).params).toEqual(
    expect.arrayContaining([
      "credential",
      "organization",
      "chatgpt_subscription",
      "active",
    ]),
  );
  returning.mockResolvedValue([]);
  await expect(
    acquireSubscriptionCredential({
      ...owner,
      expiresAt: new Date(Date.now() + 60000),
    }),
  ).rejects.toBeInstanceOf(SubscriptionCredentialUnavailableError);
});
it("persists only under the owning lease and rejects account switches", async () => {
  vi.stubEnv(
    "CREDENTIAL_ENCRYPTION_KEY",
    Buffer.alloc(32, 1).toString("base64"),
  );
  const where = vi
    .fn()
    .mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "credential" }]),
    });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(getDatabase).mockReturnValue({ update: () => ({ set }) } as never);
  await persistSubscriptionCredential({
    ...owner,
    authJson,
    previousAccountId: "account",
  });
  expect(decryptCredentials(set.mock.calls[0][0].encryptedCredentials)).toEqual(
    { authJson },
  );
  expect(new PgDialect().sqlToQuery(where.mock.calls[0][0]).params).toEqual([
    "credential",
    "organization",
    "chatgpt_subscription",
    "lease",
  ]);
  await expect(
    persistSubscriptionCredential({
      ...owner,
      authJson,
      previousAccountId: "another",
    }),
  ).rejects.toThrow("account changed");
  await releaseSubscriptionCredential(owner);
  expect(set).toHaveBeenLastCalledWith({
    subscriptionLeaseId: null,
    subscriptionLeaseExpiresAt: null,
  });
});

it("rolls back the lease claim when the stored credential is invalid", async () => {
  vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
  let committed = false;
  const transaction = vi.fn(async (callback: (db: unknown) => Promise<unknown>) => { const result = await callback(tx); committed = true; return result; });
  const tx = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ encryptedCredentials: encryptCredentials({ authJson: "invalid" }) }] }) }) }) };
  vi.mocked(getDatabase).mockReturnValue({ ...tx, transaction } as never);
  await expect(acquireSubscriptionCredential({ ...owner, expiresAt: new Date() })).rejects.toThrow();
  expect(transaction).toHaveBeenCalledOnce();
  expect(committed).toBe(false);
});

it("prefers a ChatGPT subscription for Codex and otherwise the newest API key", () => {
  const older = { id: "older-key", authType: "api_key" as const, createdAt: new Date("2026-09-01") };
  const newer = { id: "newer-key", authType: "api_key" as const, createdAt: new Date("2026-09-20") };
  const subscription = { id: "subscription", authType: "chatgpt_subscription" as const, createdAt: new Date("2026-08-01") };
  expect(chooseOrganizationModelCredential([older, subscription, newer], "codex")).toBe("subscription");
  expect(chooseOrganizationModelCredential([older, subscription, newer], "opencode")).toBe("newer-key");
  expect(chooseOrganizationModelCredential([subscription], "opencode")).toBeNull();
  expect(chooseOrganizationModelCredential([], "codex")).toBeNull();
});

it("selects among the organization's active credentials for the provider", async () => {
  const where = vi.fn().mockResolvedValue([
    { id: "key", authType: "api_key", createdAt: new Date() },
  ]);
  vi.mocked(getDatabase).mockReturnValue({ select: () => ({ from: () => ({ where }) }) } as never);
  await expect(selectOrganizationModelCredential({ harness: "claude_agent_sdk", organizationId: "organization", provider: "anthropic" })).resolves.toBe("key");
  expect(new PgDialect().sqlToQuery(where.mock.calls[0][0]).params).toEqual(["organization", "anthropic", "active"]);
});
