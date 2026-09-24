import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export type SettingsSection =
  | "billing"
  | "integrations"
  | "models"
  | "tag-mode"
  | "workspace";

export function SettingsTabs({ active }: { active: SettingsSection }) {
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [automationsEnabled, setAutomationsEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    void fetch("/api/context")
      .then(async (response) => response.ok
        ? response.json() as Promise<{ capabilities?: string[] }>
        : null)
      .catch(() => null)
      .then((context) => {
        if (mounted) {
          setAutomationsEnabled(
            context?.capabilities?.includes("automations") ?? false,
          );
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

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
        aria-current={active === "tag-mode" ? "page" : undefined}
        className={active === "tag-mode" ? "isActive" : undefined}
        to="/settings/tag-mode"
      >
        Tag mode
      </Link>
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
