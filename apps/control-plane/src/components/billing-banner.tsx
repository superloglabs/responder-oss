import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface UsageBalance {
  overageAllowed: boolean;
  remaining: number;
}

interface BillingBannerSummary {
  automations?: {
    configured: boolean;
    creditOverageAllowed?: boolean;
    machineHours?: UsageBalance | null;
    remaining: number;
  } | null;
  configured: boolean;
  enabled: boolean;
  payAsYouGo: boolean;
  remaining: number;
  usageBased?: boolean;
}

type BannerKind = "investigations" | "machine_hours" | "usage" | null;

function bannerKind(summary: BillingBannerSummary): BannerKind {
  if (!summary.enabled) return null;
  if (summary.usageBased) {
    const usage = summary.automations;
    if (!usage?.configured) return null;
    // New work needs at least one cent of credit and a minute of machine
    // time, unless the plan bills usage past them.
    if (!usage.creditOverageAllowed && usage.remaining < 0.01) return "usage";
    const machineHours = usage.machineHours;
    return machineHours && !machineHours.overageAllowed && machineHours.remaining < 1 / 60
      ? "machine_hours"
      : null;
  }
  return summary.configured && !summary.payAsYouGo && summary.remaining === 0
    ? "investigations"
    : null;
}

const REFRESH_INTERVAL_MS = 60_000;

export function BillingBanner() {
  const [banner, setBanner] = useState<BannerKind>(null);

  useEffect(() => {
    let active = true;
    async function refresh() {
      const response = await fetch("/api/billing").catch(() => null);
      if (!response?.ok) return;
      const summary = (await response.json()) as BillingBannerSummary;
      if (active) setBanner(bannerKind(summary));
    }

    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!banner) return null;
  if (banner === "machine_hours") {
    return (
      <aside className="billingBanner" role="status">
        <span>
          <strong>Machine hours used up.</strong> New investigations and runs are
          paused until your hours reset or the plan is upgraded.
        </span>
        <Link className="button button--primary" to="/settings/billing">
          Upgrade plan
        </Link>
      </aside>
    );
  }
  if (banner === "usage") {
    return (
      <aside className="billingBanner" role="status">
        <span>
          <strong>Usage limit reached.</strong> New investigations and runs are
          paused until your allowance resets or the plan is upgraded.
        </span>
        <Link className="button button--primary" to="/settings/billing">
          Upgrade plan
        </Link>
      </aside>
    );
  }
  return (
    <aside className="billingBanner" role="status">
      <span>
        <strong>Monthly limit reached.</strong> New investigations are paused until
        your allowance resets or pay-as-you-go billing is enabled.
      </span>
      <Link className="button button--primary" to="/settings/billing">
        Enable billing
      </Link>
    </aside>
  );
}
