import { describe, expect, it } from "vitest";
import {
  activeNavigationSection,
  homePath,
  navigationBlocks,
  newWorkspacePath,
  primaryNavigation,
  settingsInSidebar,
} from "./primary-navigation";

describe("primaryNavigation", () => {
  it("lists every product area by default", () => {
    expect(
      primaryNavigation({ automations: true, simplified: false }).map((item) => item.label),
    ).toEqual(["Agents", "Automations", "Skills", "PRs", "Issues", "Scans", "Suggestions", "Settings"]);
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
      { label: "Skills", section: "skills", to: "/skills" },
      { label: "PRs", section: "pull-requests", to: "/pull-requests" },
      { label: "Integrations", section: "integrations", to: "/settings" },
      { label: "Tag mode", section: "tag-mode", to: "/settings/tag-mode" },
      { label: "Settings", section: "settings", to: "/settings/workspace" },
    ]);
  });

  it("lists logs, traces and metrics with the telemetry capability", () => {
    expect(
      primaryNavigation({ automations: true, simplified: false, telemetry: true }).map((item) => item.label),
    ).toEqual(["Agents", "Issues", "Scans", "Suggestions", "Automations", "Skills", "PRs", "Overview", "Logs", "Metrics", "Traces", "Settings"]);
    expect(
      primaryNavigation({ automations: true, simplified: true, telemetry: true }).map((item) => item.label),
    ).toEqual(["Automations", "Skills", "PRs", "Overview", "Logs", "Metrics", "Traces", "Settings"]);
  });

  it("lists the traces overview and search under Traces", () => {
    const traces = primaryNavigation({ automations: true, simplified: true, telemetry: true }).find((item) => item.section === "traces");

    expect(traces?.children).toEqual([
      { label: "Overview", to: "/traces" },
      { label: "Search", to: "/traces/search" },
    ]);
  });

  it("lists alerts and synthetic checks only with telemetry and the alerts capability", () => {
    expect(
      primaryNavigation({ alerts: true, automations: true, dashboards: true, simplified: true, telemetry: true }).map((item) => item.label),
    ).toEqual(["Automations", "Skills", "PRs", "Overview", "Dashboards", "Logs", "Metrics", "Traces", "Alerts", "Synthetics", "Settings"]);
    expect(primaryNavigation({ alerts: true, automations: true, simplified: true }).map((item) => item.label)).not.toContain("Alerts");
    expect(
      primaryNavigation({ alerts: false, automations: true, simplified: true, telemetry: true }).map((item) => item.label),
    ).not.toContain("Alerts");
    expect(
      primaryNavigation({ alerts: false, automations: true, simplified: true, telemetry: true }).map((item) => item.label),
    ).not.toContain("Synthetics");
  });

  it("lists dashboards only with telemetry", () => {
    expect(
      primaryNavigation({ automations: true, dashboards: true, simplified: true, telemetry: true }).map((item) => item.label),
    ).toEqual(["Automations", "Skills", "PRs", "Overview", "Dashboards", "Logs", "Metrics", "Traces", "Settings"]);
    expect(
      primaryNavigation({ automations: true, dashboards: true, simplified: true }).map((item) => item.label),
    ).not.toContain("Dashboards");
    expect(
      primaryNavigation({ automations: true, dashboards: false, simplified: true, telemetry: true }).map((item) => item.label),
    ).not.toContain("Dashboards");
  });

  it("groups automation, explore and detect pages with telemetry", () => {
    const blocks = navigationBlocks(
      primaryNavigation({ alerts: true, automations: true, dashboards: true, simplified: true, telemetry: true }),
    ).map((block) => [block.group, block.items.map((item) => item.label)]);

    expect(blocks).toEqual([
      ["Automation", ["Automations", "Skills", "PRs"]],
      ["Explore", ["Overview", "Dashboards", "Logs", "Metrics", "Traces"]],
      ["Detect", ["Alerts", "Synthetics"]],
      [undefined, ["Settings"]],
    ]);
  });

  it("lists the other product areas above the groups with telemetry", () => {
    const blocks = navigationBlocks(
      primaryNavigation({ automations: true, simplified: false, telemetry: true }),
    ).map((block) => block.group ?? block.items[0].label);

    expect(blocks).toEqual(["Agents", "Issues", "Scans", "Suggestions", "Automation", "Explore", "Settings"]);
  });

  it("leaves pages ungrouped without telemetry", () => {
    expect(
      primaryNavigation({ alerts: true, automations: true, dashboards: true, simplified: true }).some((item) => item.group),
    ).toBe(false);
  });

  it("opens settings on integrations when telemetry moves them out of the sidebar", () => {
    expect(
      primaryNavigation({ automations: true, simplified: true, telemetry: true }).find((item) => item.section === "settings")?.to,
    ).toBe("/settings");
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

describe("settingsInSidebar", () => {
  it("lists integrations and tag mode in the sidebar only for simplified navigation without telemetry", () => {
    expect(settingsInSidebar({ simplified: true })).toBe(true);
    expect(settingsInSidebar({ simplified: true, telemetry: true })).toBe(false);
    expect(settingsInSidebar({ simplified: false })).toBe(false);
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

  it("opens the telemetry overview in simplified navigation with telemetry but without automations", () => {
    expect(homePath(["simplified_navigation", "telemetry"])).toBe("/telemetry");
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
