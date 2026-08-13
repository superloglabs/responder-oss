import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import { upsertIntegrationAccount } from "./integrations.js";
import { integrationAccounts } from "./schema.js";

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

  it("returns a newly connected GitHub account", async () => {
    const { database } = databaseDouble({ inserted: [{ id: "account-3" }] });

    await expect(
      upsertIntegrationAccount({ ...account, provider: "github" }),
    ).resolves.toBe("account-3");
    expect(database.select).not.toHaveBeenCalled();
  });
});
