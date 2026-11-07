import { useEffect, useRef, useState } from "react";
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

// Checkout can return before the plan is recorded. The step checks again
// this many times, a second apart.
const confirmAttempts = 10;

function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback;
}

// The last setup step: choose a plan, which turns Signal on after checkout.
// A workspace with a plan sees it here, can switch or manage it, and can turn
// Signal off and on.
export function SignalPlanStep({ settings, slackChosen, saving, onBack, onTurnOn, onTurnOff }: {
  settings: SignalSettings;
  slackChosen: boolean;
  saving: boolean;
  onBack: () => void;
  onTurnOn: () => Promise<void>;
  onTurnOff: () => Promise<void>;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const returning = searchParams.get("checkout") === "success";
  const [billing, setBilling] = useState<SignalBilling | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const turnedOn = useRef(false);

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

  // Signal turns on by itself only when a plan finishes setup. A workspace
  // that turned it off later keeps it off when it changes plans.
  const turnOnAfterCheckout = !settings.enabled && !settings.setupComplete && slackChosen;

  // Back from checkout with a plan: turn Signal on once.
  useEffect(() => {
    if (!returning || !billing?.plan || turnedOn.current) return;
    turnedOn.current = true;
    setSearchParams({}, { replace: true });
    if (turnOnAfterCheckout) void onTurnOn();
  }, [returning, billing, turnOnAfterCheckout, onTurnOn, setSearchParams]);

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
      if (turnOnAfterCheckout) await onTurnOn();
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

  const loading = !billing && !error;
  const current = billing?.plan ?? null;
  const ready = billing ? canTurnOnSignal(billing) : false;
  const lastPlan = billing?.plans.at(-1);

  return <>
    {error && <p className="signalError" role="alert">
      {error}{" "}
      {!billing && <button type="button" className="signalLinkButton" onClick={() => { setError(""); setAttempt(attempt + 1); }}>Try again</button>}
    </p>}
    {loading && <p className="signalLoading" role="status">{returning ? "Confirming your payment…" : "Loading plans…"}</p>}

    {billing?.enabled && <div className="signalPlans">
      {billing.plans.map((plan) => {
        const isCurrent = current?.id === plan.id;
        return <article className="signalPlan" key={plan.id} aria-label={plan.name}>
          <h3>{plan.name}</h3>
          <p className="signalPlanPrice">${plan.price}<span> / month</span></p>
          <div className="signalPlanTerms">
            <p>Up to {plan.included} investigated findings</p>
            <p>{perFinding(plan)} per finding</p>
          </div>
          <div className="signalPlanAction">
            {isCurrent
              ? <Button disabled>Current plan</Button>
              : <Button
                variant={!current && plan.id === lastPlan?.id ? "primary" : "secondary"}
                disabled={busy !== null || saving || (!current && !slackChosen)}
                onClick={() => void choose(plan)}>
                {current ? "Switch to" : "Choose"} {plan.name} (${plan.price})
              </Button>}
          </div>
        </article>;
      })}
    </div>}

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
