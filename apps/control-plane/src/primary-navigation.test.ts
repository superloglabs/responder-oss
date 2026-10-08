import { describe, expect, it } from "vitest";
import { activeNavigationSection, homePath, newWorkspacePath, primaryNavigation } from "./primary-navigation";

describe("primaryNavigation", () => {
  it("lists every product area by default", () => {
    expect(
      primaryNavigation({ automations: true, simplified: false }).map((item) => item.label),
    ).toEqual(["Agents", "Automations", "PRs", "Skills", "Issues", "Scans", "Suggestions", "Settings"]);
  });

  it("hides automations, pull requests, and skills without the automations capability", () => {
    const sections = primaryNavigation({ automations: false, simplified: false }).map((item) => item.section);
    expect(sections).not.toContain("automations");
    expect(sections).not.toContain("pull-requests");
    expect(sections).not.toContain("skills");
  });

  it("promotes integrations and tag mode in simplified navigation", () => {
    expect(primaryNavigation({ automations: true, simplified: true })).toEqual([
      { label: "Automations", section: "automations", to: "/automations" },
      { label: "PRs", section: "pull-requests", to: "/pull-requests" },
      { label: "Skills", section: "skills", to: "/skills" },
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

describe("homePath", () => {
  it("opens agents by default", () => {
    expect(homePath([])).toBe("/agents");
    expect(homePath(["automations"])).toBe("/agents");
  });

  it("opens automations in simplified navigation", () => {
    expect(homePath(["automations", "simplified_navigation"])).toBe("/automations");
  });

  it("opens integrations in simplified navigation without automations", () => {
    expect(homePath(["simplified_navigation"])).toBe("/settings");
  });
});

describe("newWorkspacePath", () => {
  it("opens guided setup when the workspace has automations", () => {
    expect(newWorkspacePath(["automations", "simplified_navigation"])).toBe("/onboarding/code");
    expect(newWorkspacePath(["automations"])).toBe("/onboarding/code");
  });

  it("opens the agent form without automations", () => {
    expect(newWorkspacePath([])).toBe("/agents/new");
  });

  it("opens the application home when the capabilities could not be read", () => {
    expect(newWorkspacePath(null)).toBe("/app");
  });
});
