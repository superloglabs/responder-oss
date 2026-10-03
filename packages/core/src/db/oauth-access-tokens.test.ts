import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const getDatabase = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({ getDatabase }));

const { authenticateOAuthAccessToken, hashOAuthAccessToken } = await import(
  "./oauth-access-tokens.js"
);

describe("OAuth access tokens", () => {
  it("hashes tokens the way Better Auth stores them", () => {
    // SHA-256 of "abc", base64url without padding.
    expect(hashOAuthAccessToken("abc")).toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
  });

  it("rejects values that are not prefixed OAuth tokens before looking them up", async () => {
    const options = { prefix: "slo_", scope: "mcp" };

    await expect(authenticateOAuthAccessToken(`slk_${"a".repeat(43)}`, options)).resolves.toBeNull();
    await expect(authenticateOAuthAccessToken("slo_short", options)).resolves.toBeNull();
    await expect(authenticateOAuthAccessToken(`slo_${"a".repeat(31)}!`, options)).resolves.toBeNull();
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("removes grants with their workspace, person, or client", () => {
    const migration = readFileSync(
      new URL("../../../../drizzle/0065_mcp_oauth.sql", import.meta.url),
      "utf8",
    );

    for (const table of ["oauth_access_token", "oauth_refresh_token", "oauth_consent"]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_reference_id_organization_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."organization"("id") ON DELETE cascade`,
      );
      expect(migration).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade`,
      );
      expect(migration).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade`,
      );
    }
  });
});
