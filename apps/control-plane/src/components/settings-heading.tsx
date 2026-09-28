import { GearIcon, PlugsConnectedIcon, TagIcon } from "@phosphor-icons/react";
import { useOrganizationCapabilities } from "../organization-capabilities";
import { SettingsTabs, type SettingsSection } from "./settings-tabs";
import "./settings.css";

// With simplified navigation these sections are sidebar pages, not tabs.
const standaloneSections = {
  integrations: {
    description: "Connect the services Superlog can use.",
    icon: PlugsConnectedIcon,
    title: "Integrations",
  },
  "tag-mode": {
    description: "Choose what Superlog can inspect when someone mentions it in Slack.",
    icon: TagIcon,
    title: "Tag mode",
  },
} as const;

export function SettingsHeading({ active }: { active: SettingsSection }) {
  const capabilities = useOrganizationCapabilities();
  const standalone = capabilities.includes("simplified_navigation") &&
      (active === "integrations" || active === "tag-mode")
    ? standaloneSections[active]
    : null;

  if (standalone) {
    const Icon = standalone.icon;
    return (
      <div className="settingsPageHeading">
        <header className="workspaceHeading"><h1><Icon size={16} aria-hidden="true" />{standalone.title}</h1></header>
        <div className="settingsPageHeading__navigation">
          <p>{standalone.description}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="settingsPageHeading">
      <header className="workspaceHeading"><h1><GearIcon size={16} aria-hidden="true" />Settings</h1></header>
      <div className="settingsPageHeading__navigation">
        <p>Manage your workspace, members, and connected services.</p>
        <SettingsTabs active={active} capabilities={capabilities} />
      </div>
    </div>
  );
}
