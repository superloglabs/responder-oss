import { Link } from "react-router-dom";
import {
  billingBanner,
  type BillingBannerKind,
  type BillingBannerSummary,
} from "../billing-banner-state";
import { Alert } from "../design-system";

// Upgrade actions open the plan comparison on the billing page.
const bannerCopy: Record<BillingBannerKind, { action: string; body: string; path: string; title: string }> = {
  investigations: {
    action: "Enable billing",
    path: "/settings/billing",
    body: "New investigations are paused until your allowance resets or pay-as-you-go billing is enabled.",
    title: "Monthly limit reached",
  },
  machine_hours: {
    action: "Upgrade plan",
    body: "New investigations and runs are paused until your hours reset or the plan is upgraded.",
    path: "/settings/billing#plans",
    title: "Machine hours used up",
  },
  usage: {
    action: "Upgrade plan",
    body: "New investigations and runs are paused until your allowance resets or the plan is upgraded.",
    path: "/settings/billing#plans",
    title: "Usage limit reached",
  },
};

export function BillingBanner({ summary }: { summary: BillingBannerSummary | null }) {
  const banner = summary ? billingBanner(summary) : null;
  if (!banner) return null;
  const copy = bannerCopy[banner];
  return (
    <Alert
      actions={
        <Link className="dsButton dsButton--primary dsButton--small" to={copy.path}>
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
