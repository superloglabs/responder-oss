import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  billingBanner,
  type BillingBannerKind,
  type BillingBannerSummary,
} from "../billing-banner-state";
import { Alert } from "../design-system";

const REFRESH_INTERVAL_MS = 60_000;

const bannerCopy: Record<BillingBannerKind, { action: string; body: string; title: string }> = {
  investigations: {
    action: "Enable billing",
    body: "New investigations are paused until your allowance resets or pay-as-you-go billing is enabled.",
    title: "Monthly limit reached",
  },
  machine_hours: {
    action: "Upgrade plan",
    body: "New investigations and runs are paused until your hours reset or the plan is upgraded.",
    title: "Machine hours used up",
  },
  usage: {
    action: "Upgrade plan",
    body: "New investigations and runs are paused until your allowance resets or the plan is upgraded.",
    title: "Usage limit reached",
  },
};

export function BillingBanner() {
  const [banner, setBanner] = useState<BillingBannerKind | null>(null);

  useEffect(() => {
    let active = true;
    async function refresh() {
      const response = await fetch("/api/billing").catch(() => null);
      if (!response?.ok) return;
      const summary = (await response.json()) as BillingBannerSummary;
      if (active) setBanner(billingBanner(summary));
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
  const copy = bannerCopy[banner];
  return (
    <Alert
      actions={
        <Link className="dsButton dsButton--primary dsButton--small" to="/settings/billing">
          {copy.action}
        </Link>
      }
      className="billingBanner"
      role="status"
      title={copy.title}
      tone="warning"
    >
      {copy.body}
    </Alert>
  );
}
