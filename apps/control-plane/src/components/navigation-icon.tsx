import {
  IconAdjustmentsHorizontalFilled,
  IconBellFilled,
  IconBoltFilled,
  IconBookFilled,
  IconBugFilled,
  IconChartAreaLineFilled,
  IconCompassFilled,
  IconFileDiffFilled,
  IconFileTextFilled,
  IconLayoutDashboardFilled,
  IconSitemapFilled,
  IconWorldFilled,
} from "@tabler/icons-react";
import {
  CoinsIcon,
  FlagIcon,
  GearIcon,
  LightningIcon,
  ListBulletsIcon,
  PlugsConnectedIcon,
  ScanIcon,
  TagIcon,
} from "@phosphor-icons/react";
import type { NavigationSection } from "../primary-navigation";

const navigationIcons: Record<NavigationSection, typeof GearIcon | typeof IconBoltFilled> = {
  agents: LightningIcon,
  "ai-models": CoinsIcon,
  alerts: IconBellFilled,
  automations: IconBoltFilled,
  dashboards: IconLayoutDashboardFilled,
  errors: IconBugFilled,
  integrations: PlugsConnectedIcon,
  issues: ListBulletsIcon,
  logs: IconFileTextFilled,
  metrics: IconChartAreaLineFilled,
  "pull-requests": IconFileDiffFilled,
  scans: ScanIcon,
  settings: IconAdjustmentsHorizontalFilled,
  skills: IconBookFilled,
  suggestions: FlagIcon,
  synthetics: IconWorldFilled,
  "tag-mode": TagIcon,
  "telemetry-overview": IconCompassFilled,
  traces: IconSitemapFilled,
};

export function NavigationIcon({ section }: { section: NavigationSection }) {
  const Icon = navigationIcons[section];
  return <Icon size={16} aria-hidden="true" />;
}
