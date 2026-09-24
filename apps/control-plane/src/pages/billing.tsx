import { useEffect, useState } from "react";
import { AppShell } from "../components/app-shell";
import { BillingSkeleton } from "../components/screen-skeletons";
import { SettingsHeading } from "../components/settings-heading";
import { useDocumentTitle } from "../use-document-title";

type AutomationPlanId =
  | "responder_automations_free"
  | "responder_automations_100"
  | "responder_automations_200";

interface AutomationBillingSummary {
  allowance: number;
  cancelsAtPeriodEnd: boolean;
  configured: boolean;
  enabled: boolean;
  nextResetAt: number | null;
  planId: AutomationPlanId;
  plans: Array<{ id: Exclude<AutomationPlanId, "responder_automations_free">; included: number; price: number }>;
  remaining: number;
  scheduledPlanId: AutomationPlanId | null;
  usage: number;
}

interface BillingSummary {
  automations: AutomationBillingSummary | null;
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
  const status = new URLSearchParams(window.location.search).get("status");
  if (status === "success") return "Payment method saved. Pay-as-you-go billing is active.";
  if (status === "automation-plan") return "Automation plan updated.";
  return null;
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function automationPlanName(summary: AutomationBillingSummary, planId: AutomationPlanId): string {
  const plan = summary.plans.find((candidate) => candidate.id === planId);
  return plan ? `$${plan.price} / month` : "Free";
}

function AutomationBilling({
  onChangePlan,
  redirecting,
  summary,
}: {
  onChangePlan: (planId: AutomationPlanId | "free") => void;
  redirecting: boolean;
  summary: AutomationBillingSummary;
}) {
  const used = Math.min(summary.usage, summary.allowance);
  const percent = summary.allowance > 0 ? Math.min(100, (used / summary.allowance) * 100) : 0;
  const paid = summary.planId !== "responder_automations_free";
  return (
    <>
      <h2 className="billingSectionTitle">Automations</h2>
      <section className="billingGrid">
        <article className="billingUsageCard">
          <header>
            <span>Included model usage this month</span>
            <strong>{dollars(summary.usage)}</strong>
          </header>
          <div
            aria-label={`${dollars(used)} of ${dollars(summary.allowance)} included usage used`}
            className="billingProgress"
            role="progressbar"
            aria-valuemax={summary.allowance}
            aria-valuemin={0}
            aria-valuenow={used}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <p>
            {dollars(summary.remaining)} of {dollars(summary.allowance)} remains.
            Resets {resetLabel(summary.nextResetAt)}. Runs that use included
            usage stop when it runs out. Runs with your own API key or ChatGPT
            subscription keep working.
          </p>
        </article>

        <article className="billingPlanCard">
          <span className="billingPlanCard__eyebrow">Automation plan</span>
          <h2>{automationPlanName(summary, summary.planId)}</h2>
          <p>
            {paid
              ? `Includes ${dollars(summary.allowance)} of model usage each month.`
              : "Includes $20.00 of model usage each month."}
            {summary.cancelsAtPeriodEnd ? " Returns to the free plan at the end of this billing period." : ""}
            {summary.scheduledPlanId
              ? ` Changes to ${automationPlanName(summary, summary.scheduledPlanId)} at the end of this billing period.`
              : ""}
          </p>
          {!summary.configured ? (
            <p className="billingConfiguration">
              Billing needs an Autumn secret key before plans can be changed.
            </p>
          ) : null}
          <div className="billingPlanActions">
            {summary.plans
              .filter((plan) => plan.id !== summary.planId)
              .map((plan) => (
                <button
                  className="button button--primary"
                  disabled={redirecting || !summary.configured}
                  key={plan.id}
                  onClick={() => onChangePlan(plan.id)}
                  type="button"
                >
                  {`Switch to $${plan.price} / month`}
                </button>
              ))}
            {paid && !summary.cancelsAtPeriodEnd ? (
              <button
                className="button button--secondary"
                disabled={redirecting}
                onClick={() => onChangePlan("free")}
                type="button"
              >
                Switch to free
              </button>
            ) : null}
          </div>
        </article>
      </section>
    </>
  );
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

  async function changeAutomationPlan(planId: AutomationPlanId | "free") {
    const plans = summary?.automations?.plans ?? [];
    const plan = plans.find((candidate) => candidate.id === planId);
    const currentPrice = plans.find(
      (candidate) => candidate.id === summary?.automations?.planId,
    )?.price ?? 0;
    // Upgrades charge a saved payment method without a checkout page, so
    // confirm first. Downgrades take effect at the end of the period.
    const confirmation = !plan
      ? "Switch to the free automation plan at the end of this billing period?"
      : plan.price > currentPrice
        ? `Switch to the $${plan.price} / month automation plan now? A saved payment method is charged immediately, prorated for this period.`
        : `Switch to the $${plan.price} / month automation plan at the end of this billing period?`;
    if (!window.confirm(confirmation)) return;
    setError(null);
    setIsRedirecting(true);
    try {
      const response = await fetch("/api/billing/automations/plan", {
        body: JSON.stringify({ planId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as { error?: string; url?: string | null };
      if (!response.ok) throw new Error(body.error ?? "Unable to change the automation plan");
      if (body.url) {
        window.location.assign(body.url);
        return;
      }
      window.location.assign("/settings/billing?status=automation-plan");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change the automation plan");
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
    <AppShell active="settings" density="settings" redesigned>
      <SettingsHeading active="billing" />

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

      {summary?.enabled && summary.automations ? (
        <AutomationBilling
          onChangePlan={(planId) => void changeAutomationPlan(planId)}
          redirecting={isRedirecting}
          summary={summary.automations}
        />
      ) : null}
    </AppShell>
  );
}
