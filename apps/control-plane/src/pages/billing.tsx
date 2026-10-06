import { useEffect, useState } from "react";
import { AppShell } from "../components/app-shell";
import { BillingSkeleton } from "../components/screen-skeletons";
import { SettingsHeading } from "../components/settings-heading";
import { useDocumentTitle } from "../use-document-title";

type AutomationPlanId = string;

interface UsageBalance {
  granted: number;
  nextResetAt: number | null;
  overageAllowed: boolean;
  remaining: number;
  usage: number;
}

interface AutomationBillingSummary {
  allowance: number;
  // Charged this period, in dollars. Null when it could not be loaded.
  breakdown?: { inference: number; sandbox: number } | null;
  cancelsAtPeriodEnd: boolean;
  configured: boolean;
  creditOverageAllowed: boolean;
  enabled: boolean;
  // Null on plans that pay for sandbox time from the usage credit.
  machineHours: UsageBalance | null;
  nextResetAt: number | null;
  paid: boolean;
  planId: AutomationPlanId;
  planName: string;
  planPrice: number;
  plans: Array<{
    id: AutomationPlanId;
    included: number;
    machineHours: number;
    name: string;
    price: number;
  }>;
  remaining: number;
  // The usage credit also pays for sandbox time.
  sandboxTimeBilled: boolean;
  scheduledPlanId: AutomationPlanId | null;
  scheduledPlanName: string | null;
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
  // The organization pays for all work from the usage allowance instead of
  // investigation credits.
  usageBased?: boolean;
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

function hours(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} h`;
}

function UsageMeter({
  format,
  label,
  total,
  usage,
}: {
  format: (value: number) => string;
  label: string;
  total: number;
  usage: number;
}) {
  const used = Math.min(usage, total);
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <>
      <header>
        <span>{label}</span>
        <strong>{format(usage)}</strong>
      </header>
      <div
        aria-label={`${format(used)} of ${format(total)} used`}
        className="billingProgress"
        role="progressbar"
        aria-valuemax={total}
        aria-valuemin={0}
        aria-valuenow={used}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </>
  );
}

// Usage credit and machine hours, for plans that include machine hours.
function PlanUsage({
  machineHours,
  summary,
}: {
  machineHours: UsageBalance;
  summary: AutomationBillingSummary;
}) {
  return (
    <article className="billingUsageCard">
      <section className="billingMeter">
        <UsageMeter
          format={dollars}
          label="Usage credit"
          total={summary.allowance}
          usage={summary.usage}
        />
        <p>
          {dollars(summary.remaining)} of {dollars(summary.allowance)} remains.{" "}
          {summary.nextResetAt ? `Resets ${resetLabel(summary.nextResetAt)}. ` : "One-time credit. "}
          {summary.creditOverageAllowed
            ? "Usage past the credit is billed at the end of the period."
            : "Runs that use Superlog models stop when it runs out. Runs with your own API key or ChatGPT subscription keep working."}
        </p>
      </section>
      <section className="billingMeter">
        <UsageMeter
          format={hours}
          label="Machine hours"
          total={machineHours.granted}
          usage={machineHours.usage}
        />
        <p>
          {hours(machineHours.remaining)} of {hours(machineHours.granted)} remain.
          Resets {resetLabel(machineHours.nextResetAt)}.{" "}
          {machineHours.overageAllowed
            ? "Extra hours are billed per hour at the end of the period."
            : "When they run out, runs in progress finish and new runs wait until they reset or the plan is upgraded."}
        </p>
      </section>
    </article>
  );
}

function planIncludes(plan: AutomationBillingSummary["plans"][number]): string {
  return `${dollars(plan.included)} of usage credit and ${plan.machineHours} machine hours each month`;
}

// Splits the used share of the bar between model usage and sandbox time in
// proportion to what each was charged.
function usageSegments(
  breakdown: { inference: number; sandbox: number },
  percent: number,
): { inference: number; sandbox: number } | null {
  const total = breakdown.inference + breakdown.sandbox;
  if (total <= 0) return null;
  const inference = (breakdown.inference / total) * percent;
  return { inference, sandbox: percent - inference };
}

function AutomationBilling({
  onChangePlan,
  onManageBilling,
  redirecting,
  summary,
  usageBased,
}: {
  onChangePlan: (planId: AutomationPlanId | "free" | "resume") => void;
  // Opens the billing portal; absent when the workspace has not paid yet.
  onManageBilling?: () => void;
  redirecting: boolean;
  summary: AutomationBillingSummary;
  usageBased: boolean;
}) {
  const used = Math.min(summary.usage, summary.allowance);
  const percent = summary.allowance > 0 ? Math.min(100, (used / summary.allowance) * 100) : 0;
  const paid = summary.paid;
  const usageKind = summary.sandboxTimeBilled ? "usage" : "model usage";
  const breakdown = summary.sandboxTimeBilled ? summary.breakdown ?? null : null;
  const segments = breakdown ? usageSegments(breakdown, percent) : null;
  const currentPlan = summary.plans.find((plan) => plan.id === summary.planId);
  return (
    <>
      <h2 className="billingSectionTitle">{usageBased ? "Usage" : "Automations"}</h2>
      <section className="billingGrid">
        {summary.machineHours ? (
          <PlanUsage machineHours={summary.machineHours} summary={summary} />
        ) : (
        <article className="billingUsageCard">
          <header>
            <span>{`Included ${usageKind} this month`}</span>
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
            {segments ? (
              <>
                <span
                  className="billingProgress__segment billingProgress__segment--inference"
                  style={{ width: `${segments.inference}%` }}
                />
                <span
                  className="billingProgress__segment billingProgress__segment--sandbox"
                  style={{ width: `${segments.sandbox}%` }}
                />
              </>
            ) : (
              <span style={{ width: `${percent}%` }} />
            )}
          </div>
          {breakdown ? (
            <dl className="billingBreakdown">
              <div>
                <dt>
                  <span aria-hidden="true" className="billingBreakdown__swatch billingBreakdown__swatch--inference" />
                  AI inference
                </dt>
                <dd>{dollars(breakdown.inference)}</dd>
              </div>
              <div>
                <dt>
                  <span aria-hidden="true" className="billingBreakdown__swatch billingBreakdown__swatch--sandbox" />
                  Sandbox compute
                </dt>
                <dd>{dollars(breakdown.sandbox)}</dd>
              </div>
            </dl>
          ) : null}
          {summary.sandboxTimeBilled ? (
            <p>
              {dollars(summary.remaining)} of {dollars(summary.allowance)} remains.
              Resets {resetLabel(summary.nextResetAt)}. Covers model usage and
              sandbox time. When it runs out, runs in progress finish and new
              runs wait until it resets or the plan is upgraded.
            </p>
          ) : (
            <p>
              {dollars(summary.remaining)} of {dollars(summary.allowance)} remains.
              Resets {resetLabel(summary.nextResetAt)}. Runs that use included
              usage stop when it runs out. Runs with your own API key or ChatGPT
              subscription keep working.
            </p>
          )}
        </article>
        )}

        <article className="billingPlanCard">
          <span className="billingPlanCard__eyebrow">
            {usageBased ? "Current plan" : "Automation plan"}
          </span>
          <h2>{summary.planName}</h2>
          <p>
            {currentPlan
              ? `Includes ${planIncludes(currentPlan)}.`
              : summary.machineHours
                ? `Includes ${dollars(summary.allowance)} of usage credit once and ${summary.machineHours.granted} machine hours each month.`
                : `Includes ${dollars(summary.allowance)} of ${usageKind} each month.`}
            {summary.cancelsAtPeriodEnd ? " Returns to the free plan at the end of this billing period." : ""}
            {summary.scheduledPlanName
              ? ` Changes to ${summary.scheduledPlanName} at the end of this billing period.`
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
                  {`Switch to ${plan.name}`}
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
            {onManageBilling ? (
              <button
                className="button button--secondary"
                disabled={redirecting}
                onClick={onManageBilling}
                type="button"
              >
                Manage billing
              </button>
            ) : null}
            {paid && summary.cancelsAtPeriodEnd ? (
              <button
                className="button button--secondary"
                disabled={redirecting}
                onClick={() => onChangePlan("resume")}
                type="button"
              >
                {`Keep ${summary.planName}`}
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

  async function changeAutomationPlan(planId: AutomationPlanId | "free" | "resume") {
    const plans = summary?.automations?.plans ?? [];
    const plan = plans.find((candidate) => candidate.id === planId);
    const currentPrice = summary?.automations?.planPrice ?? 0;
    // Upgrades charge a saved payment method without a checkout page, so
    // confirm first. Downgrades take effect at the end of the period.
    const confirmation = planId === "resume"
      ? "Keep the current automation plan after this billing period?"
      : !plan
      ? "Switch to the free automation plan at the end of this billing period?"
      : plan.price > currentPrice
        ? `Switch to ${plan.name} ($${plan.price} / month) now? A saved payment method is charged immediately, prorated for this period.`
        : `Switch to ${plan.name} ($${plan.price} / month) at the end of this billing period?`;
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

      {summary && !(summary.enabled && summary.usageBased) ? (
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
          // Usage-billed workspaces have no investigation card, so invoices
          // and payment methods are reached from here.
          onManageBilling={
            summary.usageBased &&
            (summary.payAsYouGo || summary.automations.paid)
              ? () => void openBilling("portal")
              : undefined
          }
          redirecting={isRedirecting}
          summary={summary.automations}
          usageBased={summary.usageBased ?? false}
        />
      ) : null}
    </AppShell>
  );
}
