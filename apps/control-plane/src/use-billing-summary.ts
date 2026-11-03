import { useEffect, useState } from "react";
import type { BillingBannerSummary } from "./billing-banner-state";
import type { SidebarUsageSummary } from "./sidebar-usage-state";

const REFRESH_INTERVAL_MS = 60_000;

export type ShellBillingSummary = BillingBannerSummary & SidebarUsageSummary;

// The billing summary for the banner and the sidebar usage card, refreshed
// every minute and when the window regains focus. Null until it loads or
// when it cannot.
export function useBillingSummary(enabled: boolean): ShellBillingSummary | null {
  const [summary, setSummary] = useState<ShellBillingSummary | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    async function refresh() {
      const response = await fetch("/api/billing").catch(() => null);
      if (!response?.ok) return;
      const body = (await response.json().catch(() => null)) as ShellBillingSummary | null;
      if (active && body) setSummary(body);
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
  }, [enabled]);

  return summary;
}
