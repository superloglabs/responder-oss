import { describe, expect, it } from "vitest";
import {
  canImpersonateUser,
  isSuperuserRole,
  otherCellViewUrl,
  requestedViewUser,
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

describe("viewing as a user of another cell", () => {
  const us = { id: "us", label: "United States", url: "https://us.superlog.sh" };
  const alex = {
    banned: false,
    canImpersonate: true,
    cell: us,
    createdAt: "2026-10-26T00:00:00.000Z",
    email: "alex@acme.example",
    id: "6c1f",
    name: "Alex",
  };

  it("sends a user of another cell to that cell's user support page", () => {
    expect(otherCellViewUrl(alex, "eu")).toBe(
      "https://us.superlog.sh/superuser/users?search=alex%40acme.example&view=6c1f",
    );
  });

  it("views a user of this cell here", () => {
    expect(otherCellViewUrl(alex, "us")).toBeNull();
    expect(otherCellViewUrl({ ...alex, cell: null }, null)).toBeNull();
  });

  it("acts on a handed-over link only for a user this cell listed", () => {
    expect(requestedViewUser([alex], "6c1f", "us")).toBe(alex);
    expect(requestedViewUser([alex], "6c1f", "eu")).toBeNull();
    expect(requestedViewUser([alex], "other", "us")).toBeNull();
    expect(requestedViewUser([alex], null, "us")).toBeNull();
  });
});
