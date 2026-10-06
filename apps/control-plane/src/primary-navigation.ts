export type NavigationSection =
  | "agents"
  | "automations"
  | "integrations"
  | "issues"
  | "pull-requests"
  | "scans"
  | "settings"
  | "skills"
  | "suggestions"
  | "tag-mode";

export interface NavigationItem {
  label: string;
  section: NavigationSection;
  to: string;
}

// Organizations with simplified navigation see automations and the pages
// automations depend on. The other product areas stay reachable by URL.
export function primaryNavigation(options: {
  automations: boolean;
  simplified: boolean;
}): NavigationItem[] {
  // Skills extend automations and pull requests come from their runs, so
  // both appear with them.
  const automations: NavigationItem[] = options.automations
    ? [
        { label: "Automations", section: "automations", to: "/automations" },
        { label: "PRs", section: "pull-requests", to: "/pull-requests" },
        { label: "Skills", section: "skills", to: "/skills" },
      ]
    : [];
  if (options.simplified) {
    return [
      ...automations,
      { label: "Integrations", section: "integrations", to: "/settings" },
      { label: "Tag mode", section: "tag-mode", to: "/settings/tag-mode" },
      { label: "Settings", section: "settings", to: "/settings/workspace" },
    ];
  }
  return [
    { label: "Agents", section: "agents", to: "/agents" },
    ...automations,
    { label: "Issues", section: "issues", to: "/issues" },
    { label: "Scans", section: "scans", to: "/scans" },
    { label: "Suggestions", section: "suggestions", to: "/suggestions" },
    { label: "Settings", section: "settings", to: "/settings" },
  ];
}

// Integrations and tag mode are settings tabs unless simplified navigation
// gives them their own sidebar entries.
export function activeNavigationSection(
  active: NavigationSection,
  simplified: boolean,
): NavigationSection {
  return !simplified && (active === "integrations" || active === "tag-mode")
    ? "settings"
    : active;
}

// Where the application opens for a signed-in member: the first sidebar entry.
export function homePath(capabilities: readonly string[]): string {
  return primaryNavigation({
    automations: capabilities.includes("automations"),
    simplified: capabilities.includes("simplified_navigation"),
  })[0].to;
}

// Where a member lands after creating a workspace: the form for its first
// automation, or its first agent when the workspace has no automations. When
// the capabilities could not be read, the application home chooses later.
export function newWorkspacePath(capabilities: readonly string[] | null): string {
  if (!capabilities) return "/app";
  return capabilities.includes("automations") ? "/automations/new" : "/agents/new";
}
