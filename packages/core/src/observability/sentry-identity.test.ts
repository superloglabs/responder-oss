import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrganizationName } from "../db/organizations.js";
import { organizationErrorTags } from "./sentry-identity.js";

vi.mock("../db/organizations.js", () => ({ getOrganizationName: vi.fn() }));

describe("organization error identity", () => {
  beforeEach(() => vi.mocked(getOrganizationName).mockReset());

  it("resolves the organization name without mixing organizations", async () => {
    vi.mocked(getOrganizationName).mockImplementation(async (id) => `${id} name`);
    expect(await Promise.all([organizationErrorTags("one"), organizationErrorTags("two")]))
      .toEqual([
        { organization_id: "one", organization_name: "one name" },
        { organization_id: "two", organization_name: "two name" },
      ]);
  });

  it("preserves the ID when the lookup fails or the organization is gone", async () => {
    vi.mocked(getOrganizationName).mockRejectedValueOnce(new Error("Database unavailable"));
    expect(await organizationErrorTags("one")).toEqual({ organization_id: "one" });
    vi.mocked(getOrganizationName).mockResolvedValueOnce(null);
    expect(await organizationErrorTags("one")).toEqual({ organization_id: "one" });
  });

  it("skips lookup for errors without an organization", async () => {
    expect(await organizationErrorTags(undefined)).toEqual({});
    expect(getOrganizationName).not.toHaveBeenCalled();
  });
});
