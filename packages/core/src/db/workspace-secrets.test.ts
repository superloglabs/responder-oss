import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { workspaceSecrets } from "./schema.js";

describe("workspace secret storage", () => {
  it("stores only workspace-scoped Daytona metadata, never plaintext", () => {
    const table = getTableConfig(workspaceSecrets);
    const columnNames = table.columns.map((column) => column.name);

    expect(columnNames).toContain("organization_id");
    expect(columnNames).toContain("daytona_secret_id");
    expect(columnNames).toContain("allowed_hosts");
    expect(columnNames).not.toContain("value");
    expect(columnNames).not.toContain("encrypted_value");
  });

  it("makes environment variable names unique within a workspace", () => {
    const table = getTableConfig(workspaceSecrets);
    const index = table.indexes.find(
      (candidate) =>
        candidate.config.name === "workspace_secrets_organization_name_idx",
    );

    expect(index?.config.unique).toBe(true);
    expect(
      index?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["organization_id", "name"]);
  });
});
