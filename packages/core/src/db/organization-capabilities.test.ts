import { describe, expect, it } from "vitest";
import { newOrganizationCapabilities } from "./organization-capabilities.js";

describe("newOrganizationCapabilities", () => {
  it("defaults to no capabilities", () => {
    expect(newOrganizationCapabilities(undefined)).toEqual([]);
    expect(newOrganizationCapabilities("")).toEqual([]);
  });

  it("reads a comma-separated list", () => {
    expect(
      newOrganizationCapabilities(" automations, simplified_navigation "),
    ).toEqual(["automations", "simplified_navigation"]);
  });

  it("ignores unknown and repeated names", () => {
    expect(
      newOrganizationCapabilities("automations,billing,automations"),
    ).toEqual(["automations"]);
  });
});
