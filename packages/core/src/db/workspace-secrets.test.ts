import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { workspaceSecrets } from "./schema.js";
import {
  isWorkspaceSecretEnvironmentVariableName,
  workspaceSecretEnvironmentVariableNameReservation,
} from "../workspace-secret-names.js";

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

  it("retains metadata on organization deletion and enforces tenant ownership", () => {
    const migration = readFileSync(
      new URL("../../../../drizzle/0019_parched_proudstar.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(
      '"workspace_secrets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "agent_version_secrets_organization_guard"',
    );
    expect(migration).toContain(
      'agent."organization_id" = secret."organization_id"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "agents_organization_immutable"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "workspace_secrets_organization_immutable"',
    );
  });
});

describe("workspace secret environment variable names", () => {
  it("allows application credential names", () => {
    for (const name of [
      "SERVICE_API_KEY",
      "DAYTONA_API_KEY",
      "OPENAI_API_KEY",
      "RESPONDER_API_KEY",
      "GIT_TOKEN",
      "NPM_CONFIG_TOKEN",
    ]) {
      expect(isWorkspaceSecretEnvironmentVariableName(name)).toBe(true);
    }
  });

  it.each([
    "NODE_OPTIONS",
    "HTTPS_PROXY",
    "GIT_CONFIG_COUNT",
    "GIT_WORK_TREE",
    "JAVA_TOOL_OPTIONS",
    "PYTHONSTARTUP",
    "PERL5OPT",
    "RUBYOPT",
    "DYLD_INSERT_LIBRARIES",
  ])("rejects runtime control variable %s", (name) => {
    expect(isWorkspaceSecretEnvironmentVariableName(name)).toBe(false);
  });

  it("explains reserved runtime controls", () => {
    expect(
      workspaceSecretEnvironmentVariableNameReservation("PATH"),
    ).toBe(
      "PATH controls the sandbox runtime; choose a credential-specific environment variable name",
    );
  });
});
