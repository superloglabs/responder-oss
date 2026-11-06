import {
  IconAdjustmentsHorizontalFilled,
  IconAdjustmentsHorizontal,
  IconChecklist,
  IconFlag,
  IconChartBar,
  IconBellFilled,
  IconBookmarkFilled,
  IconBoltFilled,
  IconBookFilled,
  IconBugFilled,
  IconChartAreaLineFilled,
  IconCompassFilled,
  IconFileDiffFilled,
  IconFileTextFilled,
  IconLayoutDashboardFilled,
  IconPuzzleFilled,
  IconSitemapFilled,
  IconTagFilled,
  IconWorldFilled,
} from "@tabler/icons-react";
import {
  CoinsIcon,
  FlagIcon,
  GearIcon,
  LightningIcon,
  ListBulletsIcon,
  ScanIcon,
} from "@phosphor-icons/react";
import type { NavigationSection } from "../primary-navigation";

const navigationIcons: Record<NavigationSection, typeof GearIcon | typeof IconBoltFilled> = {
  "signal-setup": IconChecklist,
  "signal-findings": IconFlag,
  "signal-usage": IconChartBar,
  agents: LightningIcon,
  "ai-models": CoinsIcon,
  alerts: IconBellFilled,
  automations: IconBoltFilled,
  dashboards: IconLayoutDashboardFilled,
  errors: IconBugFilled,
  integrations: IconPuzzleFilled,
  issues: ListBulletsIcon,
  logs: IconFileTextFilled,
  memory: IconBookmarkFilled,
  metrics: IconChartAreaLineFilled,
  "pull-requests": IconFileDiffFilled,
  scans: ScanIcon,
  settings: IconAdjustmentsHorizontalFilled,
  skills: IconBookFilled,
  suggestions: FlagIcon,
  synthetics: IconWorldFilled,
  "tag-mode": IconTagFilled,
  "telemetry-overview": IconCompassFilled,
  traces: IconSitemapFilled,
};

export function NavigationIcon({ section, signal = false }: { section: NavigationSection; signal?: boolean }) {
  const Icon = signal && section === "settings" ? IconAdjustmentsHorizontal : navigationIcons[section];
  return <Icon size={16} aria-hidden="true" />;
}
