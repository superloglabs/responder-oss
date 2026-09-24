import { GearIcon } from "@phosphor-icons/react";
import { SettingsTabs, type SettingsSection } from "./settings-tabs";
import "./settings.css";

export function SettingsHeading({ active }: { active: SettingsSection }) {
  return (
    <div className="settingsPageHeading">
      <header className="workspaceHeading"><h1><GearIcon size={16} aria-hidden="true" />Settings</h1></header>
      <div className="settingsPageHeading__navigation">
        <p>Manage your workspace, members, and connected services.</p>
        <SettingsTabs active={active} />
      </div>
    </div>
  );
}
