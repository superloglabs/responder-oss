import { useEffect, useState } from "react";
import { AppShell } from "../components/app-shell";
import { BillingSkeleton } from "../components/screen-skeletons";
import { SettingsTabs } from "../components/settings-tabs";
import { useDocumentTitle } from "../use-document-title";

interface BillingSummary {
  configured: boolean;
  enabled: boolean;
  included: number;
  nextResetAt: number | null;
  overagePrice: number;
  payAsYouGo: boolean;
  remaining: number;
  usage: number;
}

function billingNotice(): string | null {
  return new URLSearchParams(window.location.search).get("status") === "success"
    ? "Payment method saved. Pay-as-you-go billing is active."
    : null;
}

function resetLabel(timestamp: number | null): string {
  if (!timestamp) return "each month";
  return `on ${new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(timestamp))}`;
}

export function BillingPage() {
  useDocumentTitle("Billing");
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [notice] = useState(billingNotice);

  useEffect(() => {
    let active = true;
    void fetch("/api/billing")
      .then(async (response) => {
        const body = (await response.json()) as BillingSummary | { error?: string };
        if (!response.ok) {
          throw new Error("error" in body ? body.error : "Unable to load billing");
        }
        return body as BillingSummary;
      })
      .then((body) => {
        if (active) setSummary(body);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to load billing");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function openBilling(path: "checkout" | "portal") {
    setError(null);
    setIsRedirecting(true);
    try {
      const response = await fetch(`/api/billing/${path}`, { method: "POST" });
      const body = (await response.json()) as { error?: string; url?: string };
      if (!response.ok || !body.url) {
        throw new Error(body.error ?? "Unable to open billing");
      }
      window.location.assign(body.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to open billing");
      setIsRedirecting(false);
    }
  }

  const usedWithinAllowance = Math.min(summary?.usage ?? 0, summary?.included ?? 50);
  const overageUsage = summary
    ? Math.max(0, summary.usage - summary.included)
    : 0;
  const allowancePercent = summary
    ? Math.min(100, (usedWithinAllowance / summary.included) * 100)
    : 0;

  return (
    <AppShell active="settings" density="settings">
      <section className="settingsHeading">
        <h1>Settings</h1>
        <p>Manage your workspace, members, and connected services.</p>
      </section>

      <SettingsTabs active="billing" />

      {notice ? <p className="settingsNotice settingsNotice--success">{notice}</p> : null}
      {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}

      {!summary && !error ? <BillingSkeleton /> : null}

      {summary ? (
        !summary.enabled ? (
          <section className="billingDisabled">
            <h2>Billing is disabled</h2>
            <p>This deployment does not meter or limit investigations.</p>
          </section>
        ) : (
          <section className="billingGrid">
            <article className="billingUsageCard">
              <header>
                <span>Monthly investigations</span>
                <strong>{summary.usage}</strong>
              </header>
              <div
                aria-label={`${usedWithinAllowance} of ${summary.included} included investigations used`}
                className="billingProgress"
                role="progressbar"
                aria-valuemax={summary.included}
                aria-valuemin={0}
                aria-valuenow={usedWithinAllowance}
              >
                <span style={{ width: `${allowancePercent}%` }} />
              </div>
              <p>
                {summary.remaining} of {summary.included} included investigations
                remain. Resets {resetLabel(summary.nextResetAt)}.
              </p>
              {overageUsage > 0 ? (
                <p className="billingOverage">
                  {overageUsage} overage{" "}
                  {overageUsage === 1 ? "investigation" : "investigations"}
                  {" · "}${(overageUsage * summary.overagePrice).toFixed(2)}{" "}
                  estimated
                </p>
              ) : null}
            </article>

            <article className="billingPlanCard">
              <span className="billingPlanCard__eyebrow">Current plan</span>
              <h2>{summary.payAsYouGo ? "Pay as you go" : "Free"}</h2>
              <p>
                50 investigations included each month, then{" "}
                <strong>${summary.overagePrice.toFixed(2)}</strong> per
                investigation.
              </p>
              {!summary.configured ? (
                <p className="billingConfiguration">
                  Billing needs an Autumn secret key before checkout can be enabled.
                </p>
              ) : null}
              <button
                className="button button--primary"
                disabled={isRedirecting || !summary.configured}
                onClick={() =>
                  void openBilling(summary.payAsYouGo ? "portal" : "checkout")
                }
                type="button"
              >
                {isRedirecting
                  ? "Opening…"
                  : summary.payAsYouGo
                    ? "Manage billing"
                    : "Enable pay as you go"}
              </button>
            </article>
          </section>
        )
      ) : null}
    </AppShell>
  );
}
