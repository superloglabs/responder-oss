import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../design-system";
import {
  canTurnOnSignal,
  fetchSignalBilling,
  openSignalBillingPortal,
  shortDate,
  startSignalCheckout,
  type SignalBilling,
  type SignalPlan,
  type SignalSettings,
} from "./model";
import { SettingsGroup, SettingsPage, SettingsRow } from "./shared";

// Checkout can return before the plan is recorded. The step checks again
// this many times, a second apart.
const confirmAttempts = 10;

function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback;
}

// Loads the plan, waits for one after checkout, and starts checkout or the
// billing portal. `onChosen` runs once a plan is chosen, also after
// checkout comes back.
function useBilling(onChosen: () => void) {
  const [searchParams, setSearchParams] = useSearchParams();
  const returning = searchParams.get("checkout") === "success";
  const [billing, setBilling] = useState<SignalBilling | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const confirmed = useRef(false);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    async function load() {
      try {
        const loaded = await fetchSignalBilling();
        if (!current) return;
        if (returning && !loaded.plan && tries < confirmAttempts) {
          tries += 1;
          timer = setTimeout(() => void load(), 1000);
          return;
        }
        setBilling(loaded);
        if (returning && !loaded.plan) setError("Your payment is still being confirmed. Reload this page in a minute.");
      } catch (failure) {
        if (current) setError(failureMessage(failure, "Could not load your plan."));
      }
    }
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [attempt, returning]);

  // Back from checkout with a plan: act on it once.
  useEffect(() => {
    if (!returning || !billing?.plan || confirmed.current) return;
    confirmed.current = true;
    setSearchParams({}, { replace: true });
    onChosen();
  }, [returning, billing, onChosen, setSearchParams]);

  async function choose(plan: SignalPlan) {
    setBusy(plan.id);
    setError("");
    try {
      const { url } = await startSignalCheckout(plan.id);
      if (url) {
        window.location.assign(url);
        return;
      }
      // Changed without a payment page, for example with a card on file.
      setBilling(await fetchSignalBilling());
      setBusy(null);
      onChosen();
    } catch (failure) {
      setError(failureMessage(failure, "Could not start checkout."));
      setBusy(null);
    }
  }

  async function manage() {
    setBusy("portal");
    setError("");
    try {
      window.location.assign((await openSignalBillingPortal()).url);
    } catch (failure) {
      setError(failureMessage(failure, "Could not open billing."));
      setBusy(null);
    }
  }

  const status = <>
    {error && <p className="signalError" role="alert">
      {error}{" "}
      {!billing && <button type="button" className="signalLinkButton" onClick={() => { setError(""); setAttempt(attempt + 1); }}>Try again</button>}
    </p>}
    {!billing && !error && <p className="signalLoading" role="status">{returning ? "Confirming your payment…" : "Loading plans…"}</p>}
  </>;
  return { billing, busy, choose, manage, status };
}

function PlanCards({ billing, disabled, choose }: { billing: SignalBilling; disabled: boolean; choose: (plan: SignalPlan) => void }) {
  const current = billing.plan;
  const lastPlan = billing.plans.at(-1);
  return <div className="signalPlans">
    {billing.plans.map((plan) => <article className="signalPlan" key={plan.id} aria-label={plan.name}>
      <h3>{plan.name}</h3>
      <p className="signalPlanPrice">${plan.price}<span> / month</span></p>
      <div className="signalPlanTerms">
        <p>Up to {plan.included} investigated findings</p>
        <p>{perFinding(plan)} per finding</p>
      </div>
      <div className="signalPlanAction">
        {current?.id === plan.id
          ? <Button disabled>Current plan</Button>
          : <Button variant={!current && plan.id === lastPlan?.id ? "primary" : "secondary"} disabled={disabled} onClick={() => choose(plan)}>
            {current ? "Switch to" : "Choose"} {plan.name} (${plan.price})
          </Button>}
      </div>
    </article>)}
  </div>;
}

// The last setup step: choose a plan, which turns Signal on after checkout.
export function SignalPlanStep({ settings, slackChosen, saving, onBack, onTurnOn, onTurnOff }: {
  settings: SignalSettings;
  slackChosen: boolean;
  saving: boolean;
  onBack: () => void;
  onTurnOn: () => Promise<void>;
  onTurnOff: () => Promise<void>;
}) {
  // Signal turns on by itself only when a plan finishes setup.
  const turnOnAfterCheckout = !settings.enabled && !settings.setupComplete && slackChosen;
  const onChosen = useCallback(() => { if (turnOnAfterCheckout) void onTurnOn(); }, [turnOnAfterCheckout, onTurnOn]);
  const { billing, busy, choose, manage, status } = useBilling(onChosen);
  const current = billing?.plan ?? null;
  const ready = billing ? canTurnOnSignal(billing) : false;

  return <>
    {status}
    {billing?.enabled && <PlanCards billing={billing} disabled={busy !== null || saving || (!current && !slackChosen)} choose={(plan) => void choose(plan)} />}

    {billing && <PlanStatus billing={billing} settings={settings} slackChosen={slackChosen} />}

    <footer className="signalSetupActions">
      <Button onClick={onBack}>Back</Button>
      {billing && (current || ready || settings.enabled) && <div className="signalSetupChoice">
        {current && <Button disabled={busy !== null} onClick={() => void manage()}>Manage billing</Button>}
        {/* Turning off never needs a plan, so a workspace whose plan ended can still stop Signal. */}
        {settings.enabled
          ? <Button disabled={saving || busy !== null} onClick={() => void onTurnOff()}>Turn off Signal</Button>
          : ready && <Button variant="primary" disabled={saving || busy !== null || !slackChosen} onClick={() => void onTurnOn()}>Turn on Signal</Button>}
      </div>}
    </footer>
  </>;
}

const keepState = () => undefined;

// The plan page of Signal's settings, once setup is complete. Changing the
// plan leaves Signal on or off as it is; that switch is on the General page.
export function SignalPlanSettings({ settings }: { settings: SignalSettings }) {
  const { billing, busy, choose, manage, status } = useBilling(keepState);
  const current = billing?.plan ?? null;
  const resets = billing?.resetsAt ? shortDate(new Date(billing.resetsAt)) : null;
  const others = billing?.plans.filter((plan) => plan.id !== current?.id) ?? [];
  return <SettingsPage title="Plan" description="Only posted findings count. Signal stops posting at the monthly limit and starts again when it resets.">
    {status}
    {billing && !billing.enabled && <p className="signalNote">This deployment does not bill for Signal.</p>}
    {billing && settings.enabled && !canTurnOnSignal(billing) && <p className="signalError" role="alert">
      Signal has no plan, so it does not investigate. Choose a plan, or turn Signal off on the General page.
    </p>}
    {billing?.enabled && current && <SettingsGroup title="Current plan">
      <div className="signalSettingsCard signalCurrentPlan" aria-label="Current plan" role="group">
        <div className="signalCurrentPlan__summary">
          <div>
            <p><strong>{current.name}</strong> ${current.price} / month · up to {billing.included} findings</p>
            <p><strong>{billing.used} of {billing.included}</strong> findings used{resets ? ` · ${current.cancelsAtPeriodEnd ? "ends" : "resets"} ${resets}` : ""}</p>
          </div>
          {others.map((plan) => <Button key={plan.id} disabled={busy !== null} onClick={() => void choose(plan)}>Switch to {plan.name} (${plan.price})</Button>)}
        </div>
        <div className="signalMeter" role="meter" aria-label="Findings used this month" aria-valuemin={0} aria-valuemax={billing.included} aria-valuenow={billing.used}>
          <span style={{ width: `${Math.min(100, billing.included ? billing.used / billing.included * 100 : 0)}%` }} />
        </div>
        {billing.remaining < 1 && resets && !current.cancelsAtPeriodEnd && <p className="signalNote">Signal starts investigating again on {resets}.</p>}
      </div>
    </SettingsGroup>}
    {billing?.enabled && !current && <SettingsGroup title="Choose a plan">
      {billing.included > 0 && <p className="signalNote">{billing.used} of {billing.included} findings used this month{resets ? `. Resets on ${resets}` : ""}.</p>}
      <PlanCards billing={billing} disabled={busy !== null} choose={(plan) => void choose(plan)} />
    </SettingsGroup>}
    {billing?.enabled && current && <SettingsGroup title="Billing">
      <div className="signalSettingsCard signalSettingsCard--rows">
        <SettingsRow label="Payment and invoices" description="Change the payment method, see invoices, or cancel the plan.">
          <Button disabled={busy !== null} onClick={() => void manage()}>Manage billing</Button>
        </SettingsRow>
      </div>
    </SettingsGroup>}
  </SettingsPage>;
}

// Whole dollars where the price divides evenly, otherwise cents.
function perFinding(plan: SignalPlan) {
  const price = plan.price / plan.included;
  return `$${Number.isInteger(price) ? price : price.toFixed(2)}`;
}

function PlanStatus({ billing, settings, slackChosen }: {
  billing: SignalBilling;
  settings: SignalSettings;
  slackChosen: boolean;
}) {
  const resets = billing.resetsAt ? shortDate(new Date(billing.resetsAt)) : null;
  const lines: string[] = [];
  if (billing.enabled && billing.included > 0) {
    const plan = billing.plan ? `${billing.plan.name} plan: ` : "";
    lines.push(`${plan}${billing.used} of ${billing.included} findings used this month.`);
    if (billing.plan?.cancelsAtPeriodEnd && resets) lines.push(`The plan ends on ${resets}.`);
    else if (billing.remaining < 1 && resets) lines.push(`Signal starts investigating again on ${resets}.`);
    else if (resets) lines.push(`Resets on ${resets}.`);
  }
  if (!canTurnOnSignal(billing)) {
    if (settings.enabled) lines.push("Signal has no plan, so it does not investigate. Choose a plan or turn Signal off.");
    else if (!slackChosen) lines.push("Choose a Slack channel before choosing a plan.");
  } else if (settings.enabled) {
    lines.push("Signal is on. It posts findings to Slack as it finds them.");
  } else {
    lines.push(slackChosen ? "Signal will post findings to the channel you chose." : "Choose a Slack channel before turning Signal on.");
  }
  if (lines.length === 0) return null;
  return <p className="signalNote">{lines.join(" ")}</p>;
}
