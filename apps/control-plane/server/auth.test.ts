import { describe, expect, it } from "vitest";
import {
  canImpersonateSupportUser,
  configuredAuthTrustedOrigins,
  configuredSuperuserEmails,
  platformRoleForIdentity,
} from "./auth.js";

describe("configuredAuthTrustedOrigins", () => {
  it("trusts the configured auth and public callback origins", () => {
    expect(
      configuredAuthTrustedOrigins({
        BETTER_AUTH_URL: "https://responder.local",
        RESPONDER_PUBLIC_URL: "https://responder.example",
      } as NodeJS.ProcessEnv),
    ).toEqual([
      "https://responder.local",
      "https://responder.example",
    ]);
  });

  it("defaults the auth origin and removes duplicates", () => {
    expect(configuredAuthTrustedOrigins({} as NodeJS.ProcessEnv)).toEqual([
      "http://localhost:3000",
    ]);
    expect(
      configuredAuthTrustedOrigins({
        BETTER_AUTH_URL: "https://responder.example",
        RESPONDER_PUBLIC_URL: "https://responder.example",
      } as NodeJS.ProcessEnv),
    ).toEqual(["https://responder.example"]);
  });
});

describe("configuredSuperuserEmails", () => {
  it("normalizes and deduplicates the server-side allowlist", () => {
    expect(
      configuredSuperuserEmails({
        SUPERUSER_EMAILS: " Admin@Example.com, support@example.com,admin@example.com ",
      } as NodeJS.ProcessEnv),
    ).toEqual(new Set(["admin@example.com", "support@example.com"]));
  });

  it("defaults to no superusers", () => {
    expect(configuredSuperuserEmails({} as NodeJS.ProcessEnv)).toEqual(new Set());
  });

  it("prevents server-side impersonation of protected accounts", () => {
    const regularUser = {
      banned: false,
      email: "user@example.com",
      role: "user",
    };
    expect(canImpersonateSupportUser(regularUser, new Set())).toBe(true);
    expect(
      canImpersonateSupportUser(
        { ...regularUser, banned: true },
        new Set(),
      ),
    ).toBe(false);
    expect(
      canImpersonateSupportUser(
        { ...regularUser, role: "superuser" },
        new Set(),
      ),
    ).toBe(false);
    expect(
      canImpersonateSupportUser(regularUser, new Set(["user@example.com"])),
    ).toBe(false);
  });
});

describe("platformRoleForIdentity", () => {
  const superuserEmails = new Set(["admin@example.com"]);

  it("does not trust an allowlisted but unverified email address", () => {
    expect(
      platformRoleForIdentity(
        { email: "admin@example.com", emailVerified: false },
        superuserEmails,
      ),
    ).toBe("user");
  });

  it("grants the superuser role to a verified allowlisted identity", () => {
    expect(
      platformRoleForIdentity(
        { email: " Admin@Example.com ", emailVerified: true },
        superuserEmails,
      ),
    ).toBe("superuser");
  });
});
