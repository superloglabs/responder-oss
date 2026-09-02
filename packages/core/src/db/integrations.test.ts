import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import {
  createIntegrationConnectionState,
  consumeIntegrationConnectionState,
  getIntegrationConnectionState,
  IntegrationAccountCredentialSupersededError,
  updateIntegrationConnectionStateMetadata,
  upsertIntegrationAccount,
  withIntegrationAccountCredentialLease,
} from "./integrations.js";
import {
  integrationAccounts,
  integrationConnectionStates,
} from "./schema.js";

vi.mock("./client.js", () => ({
  getDatabase: vi.fn(),
}));

function databaseDouble(input: {
  inserted?: Array<{ id: string }>;
  existing?: Array<{ id: string }>;
}) {
  const returning = vi.fn().mockResolvedValue(input.inserted ?? []);
  const limit = vi.fn().mockResolvedValue(input.existing ?? []);
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const database = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({ returning })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: updateWhere })),
    })),
  };
  vi.mocked(getDatabase).mockReturnValue(database as never);
  return { database, updateWhere };
}

const account = {
  organizationId: "10000000-0000-4000-8000-000000000000",
  provider: "slack" as const,
  externalAccountId: "T123",
  displayName: "Example Slack",
};

describe("integration account tenancy", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("scopes every provider account to a Responder organization", () => {
    const indexes = getTableConfig(integrationAccounts).indexes;
    const workspaceIndex = indexes.find(
      (index) =>
        index.config.name ===
        "integration_accounts_organization_provider_external_idx",
    );
    expect(workspaceIndex?.config.unique).toBe(true);
    expect(
      workspaceIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["organization_id", "provider", "external_account_id"]);
    expect(indexes.filter((index) => index.config.unique)).toHaveLength(1);
  });

  it("returns a newly connected Slack account", async () => {
    const { database } = databaseDouble({ inserted: [{ id: "account-2" }] });

    await expect(upsertIntegrationAccount(account)).resolves.toBe("account-2");
    expect(database.select).not.toHaveBeenCalled();
  });

  it("updates an existing connection in the same Responder workspace", async () => {
    const { updateWhere } = databaseDouble({
      existing: [{ id: "account-1" }],
    });

    await expect(upsertIntegrationAccount(account)).resolves.toBe("account-1");
    expect(updateWhere).toHaveBeenCalledOnce();
  });

  it("serializes rotating credential updates without holding a transaction", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ encryptedCredentials: "old-credentials" }])
      .mockResolvedValueOnce([{ id: "account-1" }]);
    const where = vi.fn(() => ({ returning }));
    const database = {
      transaction: vi.fn(),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where })),
      })),
    };
    vi.mocked(getDatabase).mockReturnValue(database as never);
    const operation = vi.fn().mockResolvedValue({
      encryptedCredentials: "new-credentials",
      status: "connected",
      value: "refreshed",
    });

    await expect(
      withIntegrationAccountCredentialLease({
        allowedStatuses: ["connected"],
        integrationAccountId: "account-1",
        operation,
        organizationId: account.organizationId,
        provider: "sentry",
      }),
    ).resolves.toBe("refreshed");

    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.update).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledWith("old-credentials");
    expect(where).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a connection that changes during a failed refresh", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ encryptedCredentials: "old-credentials" }])
      .mockResolvedValueOnce([]);
    const set = vi.fn(() => ({
      where: vi.fn(() => ({ returning })),
    }));
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({ set })),
    } as never);

    await expect(
      withIntegrationAccountCredentialLease({
        allowedStatuses: ["connected"],
        integrationAccountId: "account-1",
        operation: async () => {
          throw new Error("refresh rejected");
        },
        organizationId: account.organizationId,
        provider: "sentry",
        statusOnError: () => "error",
      }),
    ).rejects.toBeInstanceOf(IntegrationAccountCredentialSupersededError);

    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "error" }),
    );
  });

  it("returns a newly connected GitHub account", async () => {
    const { database } = databaseDouble({ inserted: [{ id: "account-3" }] });

    await expect(
      upsertIntegrationAccount({ ...account, provider: "github" }),
    ).resolves.toBe("account-3");
    expect(database.select).not.toHaveBeenCalled();
  });

  it("atomically binds OAuth state consumption to its user and organization", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn((condition: unknown) => {
      void condition;
      return { returning };
    });
    vi.mocked(getDatabase).mockReturnValue({
      delete: vi.fn(() => ({ where })),
    } as never);

    await consumeIntegrationConnectionState("linear", "oauth-state", {
      organizationId: account.organizationId,
      userId: "20000000-0000-4000-8000-000000000000",
    });

    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never);
    expect(query.params).toEqual([
      createHash("sha256").update("oauth-state").digest("hex"),
      "linear",
      account.organizationId,
      "20000000-0000-4000-8000-000000000000",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ]);
  });

  it("updates OAuth metadata only for the live tenant-owned connection state", async () => {
    const returning = vi.fn().mockResolvedValue([{ stateHash: "state-hash" }]);
    const where = vi.fn((condition: unknown) => {
      void condition;
      return { returning };
    });
    const set = vi.fn(() => ({ where }));
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({ set })),
    } as never);

    await expect(
      updateIntegrationConnectionStateMetadata({
        metadata: { encryptedCredentials: "encrypted-credentials" },
        organizationId: account.organizationId,
        provider: "axiom",
        state: "oauth-state",
        userId: "20000000-0000-4000-8000-000000000000",
      }),
    ).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith({
      metadata: { encryptedCredentials: "encrypted-credentials" },
    });
    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never);
    expect(query.params).toEqual([
      createHash("sha256").update("oauth-state").digest("hex"),
      "axiom",
      account.organizationId,
      "20000000-0000-4000-8000-000000000000",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ]);
  });

  it("reads a live tenant-owned OAuth state without consuming it", async () => {
    const stateRow = {
      organizationId: account.organizationId,
      userId: "20000000-0000-4000-8000-000000000000",
      codeVerifier: null,
      metadata: { encryptedCredentials: "encrypted-credentials" },
      returnTo: "/settings",
    };
    const limit = vi.fn().mockResolvedValue([stateRow]);
    const where = vi.fn((condition: unknown) => {
      void condition;
      return { limit };
    });
    const from = vi.fn(() => ({ where }));
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn(() => ({ from })),
    } as never);

    await expect(getIntegrationConnectionState("supabase", "selection-state", {
      organizationId: account.organizationId,
      userId: stateRow.userId,
    })).resolves.toEqual(stateRow);

    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never);
    expect(query.params).toEqual([
      createHash("sha256").update("selection-state").digest("hex"),
      "supabase",
      account.organizationId,
      stateRow.userId,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ]);
  });

  it("bounds OAuth connection state to one live flow per owner and provider", async () => {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    vi.mocked(getDatabase).mockReturnValue({
      delete: vi.fn(() => ({ where: deleteWhere })),
      insert: vi.fn(() => ({ values })),
    } as never);

    const state = await createIntegrationConnectionState({
      organizationId: account.organizationId,
      provider: "linear",
      userId: "20000000-0000-4000-8000-000000000000",
    });

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deleteWhere).toHaveBeenCalledOnce();
    const pruneQuery = new PgDialect().sqlToQuery(
      deleteWhere.mock.calls[0]![0] as never,
    );
    expect(pruneQuery.sql).toContain('"expires_at" <= $1');
    expect(pruneQuery.params).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ]);
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [
          integrationConnectionStates.organizationId,
          integrationConnectionStates.userId,
          integrationConnectionStates.provider,
        ],
      }),
    );
  });

  it("enforces the OAuth connection-state owner/provider bound in the schema", () => {
    const indexes = getTableConfig(integrationConnectionStates).indexes;
    const ownerProviderIndex = indexes.find(
      (index) =>
        index.config.name ===
        "integration_connection_states_owner_provider_idx",
    );

    expect(ownerProviderIndex?.config.unique).toBe(true);
    expect(
      ownerProviderIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["organization_id", "user_id", "provider"]);
  });

  it("re-keys legacy Linear accounts without leaving stale credentials connected", () => {
    const migration = readFileSync(
      new URL(
        "../../../../drizzle/0024_security_hardening.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(
      '"external_account_id" = btrim("legacy"."metadata" ->> \'workspaceId\')',
    );
    expect(migration).toContain(
      '"external_account_id" = \'https://mcp.linear.app/mcp\'',
    );
    expect(migration).toContain('"encrypted_credentials" = NULL');
    expect(migration).toContain('"status" = \'error\'');
  });
});
