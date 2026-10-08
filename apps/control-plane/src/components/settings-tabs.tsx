import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { billingEnabled as loadBillingEnabled } from "../billing-api";

export type SettingsSection =
  | "api-keys"
  | "billing"
  | "integrations"
  | "mcp"
  | "models"
  | "tag-mode"
  | "workspace";

export function SettingsTabs({
  active,
  capabilities,
}: {
  active: SettingsSection;
  capabilities: string[];
}) {
  const [billingEnabled, setBillingEnabled] = useState(false);
  const automationsEnabled = capabilities.includes("automations");
  // Simplified navigation lists integrations and tag mode in the sidebar.
  const sidebarSections = capabilities.includes("simplified_navigation");

  useEffect(() => {
    let mounted = true;
    void loadBillingEnabled().then((enabled) => {
      if (mounted) setBillingEnabled(enabled);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <nav aria-label="Settings sections" className="settingsTabs">
      {sidebarSections ? null : (
        <>
          <Link
            aria-current={active === "integrations" ? "page" : undefined}
            className={active === "integrations" ? "isActive" : undefined}
            to="/settings"
          >
            Integrations
          </Link>
          <Link
            aria-current={active === "tag-mode" ? "page" : undefined}
            className={active === "tag-mode" ? "isActive" : undefined}
            to="/settings/tag-mode"
          >
            Tag mode
          </Link>
        </>
      )}
      <Link
        aria-current={active === "workspace" ? "page" : undefined}
        className={active === "workspace" ? "isActive" : undefined}
        to="/settings/workspace"
      >
        Workspace
      </Link>
      {automationsEnabled || active === "models" ? (
        <Link
          aria-current={active === "models" ? "page" : undefined}
          className={active === "models" ? "isActive" : undefined}
          to="/settings/models"
        >
          Models
        </Link>
      ) : null}
      <Link
        aria-current={active === "mcp" ? "page" : undefined}
        className={active === "mcp" ? "isActive" : undefined}
        to="/settings/mcp"
      >
        MCP
      </Link>
      <Link
        aria-current={active === "api-keys" ? "page" : undefined}
        className={active === "api-keys" ? "isActive" : undefined}
        to="/settings/api-keys"
      >
        API keys
      </Link>
      {billingEnabled || active === "billing" ? (
        <Link
          aria-current={active === "billing" ? "page" : undefined}
          className={active === "billing" ? "isActive" : undefined}
          to="/settings/billing"
        >
          Billing
        </Link>
      ) : null}
    </nav>
  );
}
