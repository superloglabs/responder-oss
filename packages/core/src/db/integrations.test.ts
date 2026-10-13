import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import {
  createIntegrationConnectionState,
  consumeIntegrationConnectionState,
  deleteIntegrationAccount,
  getIntegrationConnectionState,
  IntegrationAccountCredentialSupersededError,
  removeGitHubInstallationAccount,
  replaceGitHubInstallationAccount,
  updateIntegrationAccountSetup,
  updateIntegrationConnectionStateMetadata,
  upsertGitHubInstallationAccount,
  upsertIntegrationAccount,
  withIntegrationAccountCredentialLease,
} from "./integrations.js";
import {
  agentVersionRepositories,
  automationVersionIntegrationAccounts,
  automationVersionRepositories,
  automationVersions,
  integrationAccounts,
  integrationConnectionStates,
  repositories,
  scanConfigurations,
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
    const set = vi.fn((_values: Record<string, unknown>) => {
      void _values;
      return {
        where: vi.fn(() => ({ returning })),
      };
    });
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

  it("releases a failed credential lease without changing connection status by default", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ encryptedCredentials: "old-credentials" }])
      .mockResolvedValueOnce([{ id: "account-1" }]);
    const set = vi.fn((_values: Record<string, unknown>) => {
      void _values;
      return {
        where: vi.fn(() => ({ returning })),
      };
    });
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({ set })),
    } as never);

    await expect(
      withIntegrationAccountCredentialLease({
        allowedStatuses: ["connected"],
        integrationAccountId: "account-1",
        operation: async () => {
          throw new Error("temporary network failure");
        },
        organizationId: account.organizationId,
        provider: "supabase",
      }),
    ).rejects.toThrow("temporary network failure");

    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls.at(-1)?.[0]).not.toHaveProperty("status");
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

  it("writes setup progress only while that run round still owns a running setup", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn((condition: unknown) => {
      void condition;
      return { returning };
    });
    const set = vi.fn((values: unknown) => {
      void values;
      return { where };
    });
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({ set })),
    } as never);

    await expect(
      updateIntegrationAccountSetup({
        integrationAccountId: "30000000-0000-4000-8000-000000000000",
        owner: { round: 2, runId: "40000000-0000-4000-8000-000000000000" },
        setup: { status: "failed" },
        status: "error",
      }),
    ).resolves.toBe(false);

    const values = set.mock.calls[0]![0] as { metadata: never; status: string };
    expect(values.status).toBe("error");
    const metadata = new PgDialect().sqlToQuery(values.metadata);
    expect(metadata.sql).toContain("jsonb_set(");
    expect(metadata.params).toEqual(['{"status":"failed"}']);
    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never);
    expect(query.sql).toContain("-> 'setup' ->> 'runId' =");
    expect(query.sql).toContain("-> 'setup' ->> 'round' =");
    expect(query.sql).toContain("-> 'setup' ->> 'status' = 'running'");
    expect(query.params).toEqual([
      "30000000-0000-4000-8000-000000000000",
      "40000000-0000-4000-8000-000000000000",
      "2",
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

  describe("removing an account", () => {
    function removalDouble(input: { automationNames: string[]; found?: boolean }) {
      const deleted: unknown[] = [];
      const tx = {
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: () => ({
              where: () => ({
                for: vi.fn().mockResolvedValue(
                  input.found === false ? [] : [{ id: "account-1" }],
                ),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: () => ({
              innerJoin: () => ({
                where: vi.fn().mockResolvedValue(
                  input.automationNames.map((name) => ({ name })),
                ),
              }),
            }),
          }),
        delete: vi.fn((table: unknown) => {
          deleted.push(table);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      };
      const database = {
        transaction: vi.fn((run: (transaction: typeof tx) => unknown) => run(tx)),
      };
      vi.mocked(getDatabase).mockReturnValue(database as never);
      return { deleted };
    }

    const removal = {
      integrationAccountId: "account-1",
      organizationId: account.organizationId,
      provider: "gcp" as const,
    };

    it("keeps an account that an active automation version uses", async () => {
      const { deleted } = removalDouble({
        automationNames: ["Watch Cloud Run", "Triage errors", "Watch Cloud Run"],
      });

      await expect(deleteIntegrationAccount(removal)).resolves.toEqual({
        automationNames: ["Triage errors", "Watch Cloud Run"],
        status: "in_use",
      });
      expect(deleted).toEqual([]);
    });

    it("drops superseded version references before deleting the account", async () => {
      const { deleted } = removalDouble({ automationNames: [] });

      await expect(deleteIntegrationAccount(removal)).resolves.toEqual({
        status: "removed",
      });
      expect(deleted).toEqual([automationVersionIntegrationAccounts, integrationAccounts]);
    });

    it("reports an account from another organization as missing", async () => {
      const { deleted } = removalDouble({ automationNames: [], found: false });

      await expect(deleteIntegrationAccount(removal)).resolves.toEqual({
        status: "not_found",
      });
      expect(deleted).toEqual([]);
    });
  });

  describe("GitHub App installations", () => {
    const metadata = {
      accountId: 98,
      accountType: "Organization",
      repositorySelection: "selected",
    };

    function installationDouble(candidates: Array<{
      id: string;
      externalAccountId: string;
      updatedAt: Date;
    }>) {
      const updated: Array<{ values: unknown }> = [];
      const inserted: unknown[] = [];
      const tx = {
        select: () => ({
          from: () => ({ where: () => ({ for: vi.fn().mockResolvedValue(candidates) }) }),
        }),
        update: () => ({
          set: (values: unknown) => ({
            where: vi.fn(() => {
              updated.push({ values });
              return Promise.resolve();
            }),
          }),
        }),
        insert: () => ({
          values: (values: unknown) => {
            inserted.push(values);
            return {
              onConflictDoUpdate: () => ({
                returning: vi.fn().mockResolvedValue([{ id: "new-account" }]),
              }),
            };
          },
        }),
      };
      vi.mocked(getDatabase).mockReturnValue({
        transaction: vi.fn((run: (transaction: typeof tx) => unknown) => run(tx)),
      } as never);
      return { inserted, updated };
    }

    const install = {
      organizationId: account.organizationId,
      installationId: 3,
      displayName: "konzeptlab",
      metadata,
    };

    it("moves an earlier connection to the new installation after a reinstall", async () => {
      const { inserted, updated } = installationDouble([
        { id: "older", externalAccountId: "1", updatedAt: new Date("2026-09-01") },
        { id: "newer", externalAccountId: "2", updatedAt: new Date("2026-10-01") },
      ]);

      await expect(upsertGitHubInstallationAccount(install)).resolves.toEqual({
        id: "newer",
        replacedAccountIds: ["older"],
      });
      expect(inserted).toEqual([]);
      expect(updated).toEqual([
        {
          values: expect.objectContaining({
            externalAccountId: "3",
            metadata,
            status: "connected",
          }),
        },
      ]);
    });

    it("keeps the connection that already has the installation", async () => {
      installationDouble([
        { id: "current", externalAccountId: "3", updatedAt: new Date("2026-09-01") },
        { id: "stale", externalAccountId: "2", updatedAt: new Date("2026-10-01") },
      ]);

      await expect(upsertGitHubInstallationAccount(install)).resolves.toEqual({
        id: "current",
        replacedAccountIds: ["stale"],
      });
    });

    it("creates a connection for a GitHub account seen for the first time", async () => {
      const { inserted } = installationDouble([]);

      await expect(upsertGitHubInstallationAccount(install)).resolves.toEqual({
        id: "new-account",
        replacedAccountIds: [],
      });
      expect(inserted).toEqual([
        expect.objectContaining({
          externalAccountId: "3",
          organizationId: account.organizationId,
          provider: "github",
        }),
      ]);
    });

    function removalDouble(input: { found?: boolean; usedBy?: number }) {
      const deleted: unknown[] = [];
      const updated: unknown[] = [];
      const usage = [[], [], []].map((rows, index) =>
        index === input.usedBy ? [{ id: "version-1" }] : rows,
      );
      const usageQuery = (rows: unknown[]) => {
        const query = {
          from: () => query,
          innerJoin: () => query,
          where: () => query,
          limit: () => Promise.resolve(rows),
        };
        return query;
      };
      const select = vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              for: vi.fn().mockResolvedValue(input.found === false ? [] : [{ id: "account-1" }]),
            }),
          }),
        })
        .mockReturnValueOnce({ from: () => ({ where: () => "account repositories" }) })
        .mockReturnValueOnce(usageQuery(usage[0]!))
        .mockReturnValueOnce(usageQuery(usage[1]!))
        .mockReturnValueOnce(usageQuery(usage[2]!));
      const tx = {
        select,
        update: (table: unknown) => ({
          set: (values: unknown) => ({
            where: vi.fn(() => {
              updated.push({ table, values });
              return Promise.resolve();
            }),
          }),
        }),
        delete: vi.fn((table: unknown) => {
          deleted.push(table);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      };
      vi.mocked(getDatabase).mockReturnValue({
        transaction: vi.fn((run: (transaction: typeof tx) => unknown) => run(tx)),
      } as never);
      return { deleted, updated };
    }

    it("deletes a removed installation that nothing active uses", async () => {
      const { deleted, updated } = removalDouble({});

      await expect(removeGitHubInstallationAccount("account-1")).resolves.toBe("removed");
      expect(deleted).toEqual([
        automationVersionRepositories,
        automationVersionIntegrationAccounts,
        integrationAccounts,
      ]);
      expect(updated).toEqual([]);
    });

    it.each([0, 1, 2])(
      "keeps a removed installation that an active automation or agent uses (%i)",
      async (usedBy) => {
        const { deleted, updated } = removalDouble({ usedBy });

        await expect(removeGitHubInstallationAccount("account-1")).resolves.toBe("disconnected");
        expect(deleted).toEqual([]);
        expect(updated).toEqual([
          { table: integrationAccounts, values: expect.objectContaining({ status: "error" }) },
          { table: repositories, values: expect.objectContaining({ available: false }) },
        ]);
      },
    );

    it("reports a connection that no longer exists", async () => {
      const { deleted } = removalDouble({ found: false });

      await expect(removeGitHubInstallationAccount("account-1")).resolves.toBe("not_found");
      expect(deleted).toEqual([]);
    });

    it("moves what used an earlier connection onto the new installation", async () => {
      const selected = [
        [{ from: "old-repo", to: "new-repo" }],
        [{ automationVersionId: "version-1", repositoryId: "old-repo", position: 0 }],
        [{ agentConfigVersionId: "agent-version-1", repositoryId: "old-repo" }],
        [{ automationVersionId: "version-1", integrationAccountId: "old", role: "trigger" }],
        [{
          id: "version-1",
          triggers: [
            { eventTypes: ["opened"], integrationAccountId: "old", kind: "github", repositoryIds: ["old-repo", "gone-repo"] },
            { kind: "schedule", cron: "0 * * * *" },
          ],
        }],
        [{ organizationId: account.organizationId, repositoryIds: ["old-repo"] }],
        // The earlier connection, its repositories, and no active usage.
        [{ id: "old" }],
        [],
        [],
        [],
        [],
      ];
      const query = (rows: unknown) => {
        const chain = {
          from: () => chain,
          innerJoin: () => chain,
          where: () => chain,
          for: () => chain,
          limit: () => chain,
          then: (resolve: (value: unknown) => unknown) => resolve(rows),
        };
        return chain;
      };
      const inserted: Array<{ table: unknown; values: unknown }> = [];
      const deleted: unknown[] = [];
      const updated: Array<{ table: unknown; values: unknown }> = [];
      const tx = {
        select: vi.fn(() => query(selected.shift())),
        insert: (table: unknown) => ({
          values: (values: unknown) => {
            inserted.push({ table, values });
            return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
          },
        }),
        delete: (table: unknown) => {
          deleted.push(table);
          return { where: vi.fn().mockResolvedValue(undefined) };
        },
        update: (table: unknown) => ({
          set: (values: unknown) => ({
            where: vi.fn(() => {
              updated.push({ table, values });
              return Promise.resolve();
            }),
          }),
        }),
      };
      vi.mocked(getDatabase).mockReturnValue({
        transaction: vi.fn((run: (transaction: typeof tx) => unknown) => run(tx)),
      } as never);

      await expect(
        replaceGitHubInstallationAccount({ accountId: "new", replacedAccountId: "old" }),
      ).resolves.toBe("removed");
      expect(inserted).toEqual([
        {
          table: automationVersionRepositories,
          values: [{ automationVersionId: "version-1", repositoryId: "new-repo", position: 0 }],
        },
        {
          table: agentVersionRepositories,
          values: [{ agentConfigVersionId: "agent-version-1", repositoryId: "new-repo" }],
        },
        {
          table: automationVersionIntegrationAccounts,
          values: [{ automationVersionId: "version-1", integrationAccountId: "new", role: "trigger" }],
        },
      ]);
      expect(deleted).toEqual([
        automationVersionRepositories,
        agentVersionRepositories,
        automationVersionIntegrationAccounts,
        automationVersionRepositories,
        automationVersionIntegrationAccounts,
        integrationAccounts,
      ]);
      expect(updated).toEqual([
        {
          table: automationVersions,
          values: {
            triggers: [
              { eventTypes: ["opened"], integrationAccountId: "new", kind: "github", repositoryIds: ["new-repo", "gone-repo"] },
              { kind: "schedule", cron: "0 * * * *" },
            ],
          },
        },
        { table: scanConfigurations, values: { repositoryIds: ["new-repo"] } },
      ]);
    });
  });
});
