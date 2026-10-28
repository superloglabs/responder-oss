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
  const ali = {
    banned: false,
    canImpersonate: true,
    cell: us,
    createdAt: "2026-10-26T00:00:00.000Z",
    email: "ali@nautilus.co",
    id: "6c1f",
    name: "Ali",
  };

  it("sends a user of another cell to that cell's user support page", () => {
    expect(otherCellViewUrl(ali, "eu")).toBe(
      "https://us.superlog.sh/superuser/users?search=ali%40nautilus.co&view=6c1f",
    );
  });

  it("views a user of this cell here", () => {
    expect(otherCellViewUrl(ali, "us")).toBeNull();
    expect(otherCellViewUrl({ ...ali, cell: null }, null)).toBeNull();
  });

  it("acts on a handed-over link only for a user this cell listed", () => {
    expect(requestedViewUser([ali], "6c1f", "us")).toBe(ali);
    expect(requestedViewUser([ali], "6c1f", "eu")).toBeNull();
    expect(requestedViewUser([ali], "other", "us")).toBeNull();
    expect(requestedViewUser([ali], null, "us")).toBeNull();
  });
});
