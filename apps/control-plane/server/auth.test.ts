import { beforeEach, describe, expect, it, vi } from "vitest";
import { setOrganizationCapability } from "../../../packages/core/src/db/organization-capabilities.js";
import {
  authSignupMethod,
  canImpersonateSupportUser,
  configuredAuthTrustedOrigins,
  configuredSuperuserEmails,
  grantNewOrganizationCapabilities,
  platformRoleForIdentity,
} from "./auth.js";

vi.mock(
  "../../../packages/core/src/db/organization-capabilities.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../packages/core/src/db/organization-capabilities.js")
    >()),
    setOrganizationCapability: vi.fn(),
  }),
);

describe("grantNewOrganizationCapabilities", () => {
  beforeEach(() => {
    vi.mocked(setOrganizationCapability).mockReset();
  });

  it("enables each configured capability for the new organization", async () => {
    await grantNewOrganizationCapabilities(
      "organization-id",
      "user-id",
      "automations,simplified_navigation",
    );

    expect(vi.mocked(setOrganizationCapability).mock.calls).toEqual([
      [{ capability: "automations", enabled: true, organizationId: "organization-id", updatedBy: "user-id" }],
      [{ capability: "simplified_navigation", enabled: true, organizationId: "organization-id", updatedBy: "user-id" }],
    ]);
  });

  it("grants nothing without configuration", async () => {
    await grantNewOrganizationCapabilities("organization-id", "user-id", undefined);

    expect(setOrganizationCapability).not.toHaveBeenCalled();
  });

  it("keeps granting after one capability fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(setOrganizationCapability).mockRejectedValueOnce(new Error("database unavailable"));

    await grantNewOrganizationCapabilities(
      "organization-id",
      "user-id",
      "automations,simplified_navigation",
    );

    expect(setOrganizationCapability).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});

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

describe("authSignupMethod", () => {
  it("reads the social provider from the OAuth callback route", () => {
    expect(authSignupMethod({ path: "/callback/:id", params: { id: "google" } })).toBe("google");
    expect(authSignupMethod({ path: "/callback/:id", params: { id: "github" } })).toBe("github");
  });

  it("recognizes email sign-up", () => {
    expect(authSignupMethod({ path: "/sign-up/email" })).toBe("email");
  });

  it("reports other user creation as unknown", () => {
    expect(authSignupMethod({ path: "/admin/create-user" })).toBe("unknown");
    expect(authSignupMethod(undefined)).toBe("unknown");
  });
});
