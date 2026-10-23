export type NavigationSection =
  | "agents"
  | "ai-models"
  | "alerts"
  | "automations"
  | "dashboards"
  | "errors"
  | "integrations"
  | "issues"
  | "logs"
  | "metrics"
  | "pull-requests"
  | "scans"
  | "settings"
  | "skills"
  | "suggestions"
  | "synthetics"
  | "tag-mode"
  | "telemetry-overview"
  | "traces";

export type NavigationGroup = "Automation" | "Detect" | "Explore";

export interface NavigationItem {
  // Pages within the section, listed under it while it is open.
  children?: Array<{ label: string; to: string }>;
  // The labeled sidebar block the item belongs to.
  group?: NavigationGroup;
  label: string;
  section: NavigationSection;
  to: string;
}

interface NavigationOptions {
  // Shown only with telemetry.
  alerts?: boolean;
  automations: boolean;
  // Shown only with telemetry.
  dashboards?: boolean;
  simplified: boolean;
  telemetry?: boolean;
}

// Organizations with simplified navigation see automations and the pages
// automations depend on. The other product areas stay reachable by URL.
// With telemetry the sidebar groups automation and telemetry pages under
// labels, and lists the remaining product areas above them.
export function primaryNavigation(options: NavigationOptions): NavigationItem[] {
  const grouped = Boolean(options.telemetry);
  const inGroup = (group: NavigationGroup, items: NavigationItem[]) =>
    grouped ? items.map((item) => ({ ...item, group })) : items;
  // Skills extend automations and pull requests come from their runs, so
  // both appear with them.
  const automations = options.automations
    ? inGroup("Automation", [
        { label: "Automations", section: "automations", to: "/automations" },
        { label: "Skills", section: "skills", to: "/skills" },
        { label: "PRs", section: "pull-requests", to: "/pull-requests" },
      ])
    : [];
  const telemetry = options.telemetry
    ? [
        ...inGroup("Explore", [
          { label: "Overview", section: "telemetry-overview", to: "/telemetry" },
          ...(options.dashboards ? [{ label: "Dashboards", section: "dashboards" as const, to: "/dashboards" }] : []),
          { label: "Logs", section: "logs", to: "/logs" },
          { label: "Metrics", section: "metrics", to: "/metrics" },
          {
            children: [
              { label: "Overview", to: "/traces" },
              { label: "Search", to: "/traces/search" },
            ],
            label: "Traces",
            section: "traces",
            to: "/traces",
          },
        ]),
        // Errors come with telemetry; alerts and synthetic checks need alerts.
        ...inGroup("Detect", [
          { label: "Errors", section: "errors", to: "/errors" },
          ...(options.alerts
            ? [
                { label: "Alerts", section: "alerts" as const, to: "/alerts" },
                { label: "Synthetics", section: "synthetics" as const, to: "/synthetics" },
              ]
            : []),
        ]),
      ]
    : [];
  if (options.simplified) {
    const sidebarSettings = settingsInSidebar(options);
    return [
      ...automations,
      ...telemetry,
      ...(sidebarSettings
        ? [
            { label: "Integrations", section: "integrations" as const, to: "/settings" },
            { label: "Tag mode", section: "tag-mode" as const, to: "/settings/tag-mode" },
          ]
        : []),
      { label: "Settings", section: "settings", to: sidebarSettings ? "/settings/workspace" : "/settings" },
    ];
  }
  const agents: NavigationItem = { label: "Agents", section: "agents", to: "/agents" };
  const productAreas: NavigationItem[] = [
    { label: "Issues", section: "issues", to: "/issues" },
    { label: "Scans", section: "scans", to: "/scans" },
    { label: "Suggestions", section: "suggestions", to: "/suggestions" },
  ];
  const settings: NavigationItem = { label: "Settings", section: "settings", to: "/settings" };
  // Ungrouped pages go above the groups so none reads as part of one.
  return grouped
    ? [agents, ...productAreas, ...automations, ...telemetry, settings]
    : [agents, ...automations, ...productAreas, settings];
}

// Consecutive items of one group form a labeled block. Ungrouped items are
// blocks of their own.
export function navigationBlocks(
  items: NavigationItem[],
): Array<{ group?: NavigationGroup; items: NavigationItem[] }> {
  const blocks: Array<{ group?: NavigationGroup; items: NavigationItem[] }> = [];
  for (const item of items) {
    const last = blocks.at(-1);
    if (item.group && last?.group === item.group) last.items.push(item);
    else blocks.push({ group: item.group, items: [item] });
  }
  return blocks;
}

// Simplified navigation gives integrations and tag mode their own sidebar
// entries. With telemetry they stay settings tabs.
export function settingsInSidebar(options: Pick<NavigationOptions, "simplified" | "telemetry">): boolean {
  return options.simplified && !options.telemetry;
}

// Integrations and tag mode highlight settings while they are settings tabs.
export function activeNavigationSection(
  active: NavigationSection,
  sidebarSettings: boolean,
): NavigationSection {
  return !sidebarSettings && (active === "integrations" || active === "tag-mode")
    ? "settings"
    : active;
}

// Where the application opens for a signed-in member: the first sidebar entry.
export function homePath(capabilities: readonly string[]): string {
  return primaryNavigation(navigationOptions(capabilities))[0].to;
}

export function navigationOptions(capabilities: readonly string[]): NavigationOptions {
  return {
    alerts: capabilities.includes("alerts"),
    automations: capabilities.includes("automations"),
    dashboards: capabilities.includes("dashboards"),
    simplified: capabilities.includes("simplified_navigation"),
    telemetry: capabilities.includes("telemetry"),
  };
}

// Where a member lands after creating a workspace: guided setup that ends at
// its first automation, or its first agent when the workspace has no
// automations. When the capabilities could not be read, the application home
// chooses later.
export function newWorkspacePath(capabilities: readonly string[] | null): string {
  if (!capabilities) return "/app";
  return capabilities.includes("automations") ? "/onboarding/code" : "/agents/new";
}
