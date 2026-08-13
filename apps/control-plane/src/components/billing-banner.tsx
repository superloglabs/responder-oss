import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface BillingBannerSummary {
  configured: boolean;
  enabled: boolean;
  payAsYouGo: boolean;
  remaining: number;
}

const REFRESH_INTERVAL_MS = 60_000;

export function BillingBanner() {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    let active = true;
    async function refresh() {
      const response = await fetch("/api/billing").catch(() => null);
      if (!response?.ok) return;
      const summary = (await response.json()) as BillingBannerSummary;
      if (active) {
        setShowBanner(
          summary.enabled &&
            summary.configured &&
            !summary.payAsYouGo &&
            summary.remaining === 0,
        );
      }
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

  if (!showBanner) return null;
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
