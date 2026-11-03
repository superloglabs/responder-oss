import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  usagePlanLabel,
  usageResetLabel,
  usageWindowLabel,
} from "../subscription-usage-presentation";
import { subscriptionUsageStore } from "../subscription-usage-store";

// The server reads limits at most every five minutes.
const REFRESH_INTERVAL_MS = 5 * 60_000;
// The bar turns amber from this share of a limit.
const NEAR_LIMIT_PERCENT = 90;

// Rate limits of the workspace's connected ChatGPT subscriptions.
export function SidebarUsageCard({ enabled }: { enabled: boolean }) {
  const [subscriptions, setSubscriptions] = useState(subscriptionUsageStore.current);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refresh = () =>
      void subscriptionUsageStore.refresh().then((loaded) => {
        if (active) setSubscriptions(loaded);
      });

    refresh();
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [enabled]);

  if (!enabled || subscriptions.length === 0) return null;
  const several = subscriptions.length > 1;
  return (
    <Link className="sidebarUsage" to="/settings/models">
      {subscriptions.map((subscription) => {
        const plan = usagePlanLabel(subscription.usage?.planType ?? null);
        return (
          <span className="sidebarUsage__subscription" key={subscription.id}>
            <span className="sidebarUsage__header">
              <span>{several ? subscription.label : "ChatGPT subscription"}</span>
              {plan ? <span className="sidebarUsage__plan">{plan}</span> : null}
            </span>
            {!subscription.usage ? (
              <span className="sidebarUsage__note">Limits are unavailable right now.</span>
            ) : (
              subscription.usage.windows.map((window, index) => {
                const label = usageWindowLabel(window.windowMinutes);
                const percent = Math.round(window.usedPercent);
                const reset = usageResetLabel(window.resetsAt);
                return (
                  <span className="sidebarUsage__meter" key={index}>
                    <span className="sidebarUsage__row">
                      <span>{label}</span>
                      <span className="sidebarUsage__amount">{`${percent}% used`}</span>
                    </span>
                    <span
                      aria-label={`${label}: ${percent}% used`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={percent}
                      className={`sidebarUsage__bar${window.usedPercent >= NEAR_LIMIT_PERCENT ? " sidebarUsage__bar--near" : ""}`}
                      role="progressbar"
                    >
                      <span style={{ width: `${window.usedPercent}%` }} />
                    </span>
                    {reset ? <span className="sidebarUsage__note">{reset}</span> : null}
                  </span>
                );
              })
            )}
          </span>
        );
      })}
    </Link>
  );
}
