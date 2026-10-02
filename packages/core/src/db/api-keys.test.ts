import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  apiKeyDisplayPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
  isApiKeyToken,
} from "./api-keys.js";
import { apiKeys } from "./schema.js";

describe("API keys", () => {
  it("generates distinct prefixed keys with 256 bits of randomness", () => {
    const first = generateApiKeyToken();
    const second = generateApiKeyToken();

    expect(first).toMatch(/^slk_[A-Za-z0-9_-]{43}$/u);
    expect(isApiKeyToken(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("rejects values that are not API keys before looking them up", () => {
    expect(isApiKeyToken("")).toBe(false);
    expect(isApiKeyToken("slk_short")).toBe(false);
    expect(isApiKeyToken(`Bearer ${generateApiKeyToken()}`)).toBe(false);
    expect(isApiKeyToken(`slk_${"a".repeat(42)}!`)).toBe(false);
  });

  it("shows only the prefix and eight characters", () => {
    const token = generateApiKeyToken();

    expect(apiKeyDisplayPrefix(token)).toBe(token.slice(0, 12));
  });

  it("stores a SHA-256 digest, never the key", () => {
    const columns = getTableConfig(apiKeys).columns.map((column) => column.name);

    expect(columns).toContain("token_hash");
    expect(columns).not.toContain("token");
    expect(hashApiKeyToken("slk_example")).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashApiKeyToken("slk_example")).toBe(hashApiKeyToken("slk_example"));
  });

  it("deletes keys with their workspace or creator", () => {
    const migration = readFileSync(
      new URL("../../../../drizzle/0063_api_keys.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(
      'FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "api_keys_token_hash_idx"',
    );
  });
});
