import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashTelemetryIngestToken, isTelemetryIngestToken } from "./telemetry-ingest-keys.js";

describe("telemetry ingest keys", () => {
  const migration = readFileSync(new URL("../../../../drizzle/0079_telemetry_ingest_keys.sql", import.meta.url), "utf8");
  const workspaceMigration = readFileSync(new URL("../../../../drizzle/0081_workspace_telemetry.sql", import.meta.url), "utf8");

  it("stores one digest per key, and removes keys with their workspace", () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "telemetry_ingest_keys_token_hash_idx"');
    expect(migration).toMatch(/FOREIGN KEY \("organization_id"\) REFERENCES "public"\."organization"\("id"\) ON DELETE cascade/u);
  });

  it("drops the key's project link before the project table", () => {
    const constraint = workspaceMigration.indexOf('DROP CONSTRAINT "telemetry_ingest_keys_project_fk"');
    const table = workspaceMigration.indexOf('DROP TABLE "telemetry_projects"');
    expect(constraint).toBeGreaterThanOrEqual(0);
    expect(table).toBeGreaterThan(constraint);
  });

  it("recognizes only well-formed keys and hashes them", () => {
    expect(isTelemetryIngestToken(`sl_ingest_${"a".repeat(43)}`)).toBe(true);
    expect(isTelemetryIngestToken(`sl_public_${"a".repeat(43)}`)).toBe(false);
    expect(isTelemetryIngestToken("sl_ingest_short")).toBe(false);
    expect(hashTelemetryIngestToken("x")).toMatch(/^[0-9a-f]{64}$/u);
  });
});
