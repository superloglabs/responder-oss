import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

type SettingsSection = "billing" | "integrations" | "workspace";

export function SettingsTabs({ active }: { active: SettingsSection }) {
  const [billingEnabled, setBillingEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    void fetch("/api/billing")
      .then(async (response) => {
        if (!response.ok) return false;
        const summary = (await response.json()) as { enabled?: boolean };
        return summary.enabled === true;
      })
      .catch(() => false)
      .then((enabled) => {
        if (mounted) setBillingEnabled(enabled);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <nav aria-label="Settings sections" className="settingsTabs">
      <Link
        aria-current={active === "integrations" ? "page" : undefined}
        className={active === "integrations" ? "isActive" : undefined}
        to="/settings"
      >
        Integrations
      </Link>
      <Link
        aria-current={active === "workspace" ? "page" : undefined}
        className={active === "workspace" ? "isActive" : undefined}
        to="/settings/workspace"
      >
        Workspace
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
