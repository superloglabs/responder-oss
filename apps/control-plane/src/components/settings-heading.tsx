import { NavigationIcon } from "./navigation-icon";
import { useOrganizationCapabilities } from "../organization-capabilities";
import { navigationOptions, settingsInSidebar } from "../primary-navigation";
import { SettingsTabs, type SettingsSection } from "./settings-tabs";
import "./settings.css";

// Sections that are sidebar pages, not tabs, in simplified navigation.
const standaloneSections = {
  integrations: {
    description: "Connect the services Superlog can use.",
    section: "integrations",
    title: "Integrations",
  },
  "tag-mode": {
    description: "Choose what Superlog can use and change when someone mentions it in Slack.",
    section: "tag-mode",
    title: "Tag mode",
  },
} as const;

export function SettingsHeading({ active }: { active: SettingsSection }) {
  const capabilities = useOrganizationCapabilities();
  const standalone = settingsInSidebar(navigationOptions(capabilities)) &&
      (active === "integrations" || active === "tag-mode")
    ? standaloneSections[active]
    : null;

  if (standalone) {
    return (
      <div className="settingsPageHeading">
        <header className="workspaceHeading"><h1><NavigationIcon section={standalone.section} />{standalone.title}</h1></header>
        <div className="settingsPageHeading__navigation">
          <p>{standalone.description}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="settingsPageHeading">
      <header className="workspaceHeading"><h1><NavigationIcon section="settings" />Settings</h1></header>
      <div className="settingsPageHeading__navigation">
        <p>Manage your workspace, members, and connected services.</p>
        <SettingsTabs active={active} capabilities={capabilities} />
      </div>
    </div>
  );
}
