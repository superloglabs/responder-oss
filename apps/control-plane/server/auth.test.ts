import { describe, expect, it } from "vitest";
import {
  canImpersonateSupportUser,
  configuredSuperuserEmails,
} from "./auth.js";

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
