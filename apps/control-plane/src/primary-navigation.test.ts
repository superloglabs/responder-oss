import { describe, expect, it } from "vitest";
import { activeNavigationSection, primaryNavigation } from "./primary-navigation";

describe("primaryNavigation", () => {
  it("lists every product area by default", () => {
    expect(
      primaryNavigation({ automations: true, simplified: false }).map((item) => item.label),
    ).toEqual(["Agents", "Automations", "Issues", "Scans", "Suggestions", "Settings"]);
  });

  it("hides automations without the automations capability", () => {
    expect(
      primaryNavigation({ automations: false, simplified: false }).map((item) => item.section),
    ).not.toContain("automations");
  });

  it("promotes integrations and tag mode in simplified navigation", () => {
    expect(primaryNavigation({ automations: true, simplified: true })).toEqual([
      { label: "Automations", section: "automations", to: "/automations" },
      { label: "Integrations", section: "integrations", to: "/settings" },
      { label: "Tag mode", section: "tag-mode", to: "/settings/tag-mode" },
      { label: "Settings", section: "settings", to: "/settings/workspace" },
    ]);
  });

  it("keeps simplified navigation usable without automations", () => {
    expect(
      primaryNavigation({ automations: false, simplified: true }).map((item) => item.label),
    ).toEqual(["Integrations", "Tag mode", "Settings"]);
  });
});

describe("activeNavigationSection", () => {
  it("highlights settings for its tabs by default", () => {
    expect(activeNavigationSection("integrations", false)).toBe("settings");
    expect(activeNavigationSection("tag-mode", false)).toBe("settings");
  });

  it("highlights the promoted entries in simplified navigation", () => {
    expect(activeNavigationSection("integrations", true)).toBe("integrations");
    expect(activeNavigationSection("tag-mode", true)).toBe("tag-mode");
  });
});
