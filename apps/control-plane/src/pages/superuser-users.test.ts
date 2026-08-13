import { describe, expect, it } from "vitest";
import {
  canImpersonateUser,
  isSuperuserRole,
} from "./superuser-users-presentation.js";

describe("superuser impersonation eligibility", () => {
  it("allows active regular users", () => {
    expect(canImpersonateUser({ canImpersonate: true })).toBe(true);
  });

  it("uses the server's eligibility decision for protected users", () => {
    expect(canImpersonateUser({ canImpersonate: false })).toBe(false);
  });

  it("recognizes a superuser in a comma-separated role value", () => {
    expect(isSuperuserRole("user,superuser")).toBe(true);
    expect(isSuperuserRole("user")).toBe(false);
  });
});
