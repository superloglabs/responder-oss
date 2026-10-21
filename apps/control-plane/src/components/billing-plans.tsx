import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRightIcon, CaretDownIcon, CheckIcon, XIcon } from "@phosphor-icons/react";
import {
  planAdditions,
  planChoice,
  planChoiceNote,
  recommendedPlanId,
  upgradePlans,
  type PlanBillingState,
  type PlanCatalog,
  type PlanChoice,
  type PlanComparisonValue,
} from "../plan-comparison";
import { useDialogFocusTrap } from "../use-dialog-focus-trap";
import "./billing-plans.css";

export const BILLING_PLANS_ID = "plans";

function ComparisonValue({ value }: { value: PlanComparisonValue }) {
  if (value === true) {
    return (
      <span className="billingPlans__check">
        <CheckIcon aria-hidden="true" size={14} weight="bold" />
        <span className="billingPlans__srOnly">Included</span>
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="billingPlans__dash">
        <span aria-hidden="true">—</span>
        <span className="billingPlans__srOnly">Not included</span>
      </span>
    );
  }
  return <>{value}</>;
}

function PlanAction({
  choice,
  disabled,
  onChangePlan,
  primary,
}: {
  choice: PlanChoice;
  disabled: boolean;
  onChangePlan: (planId: string) => void;
  primary: boolean;
}) {
  const className = `billingPlans__action${primary ? " billingPlans__action--primary" : ""}`;
  switch (choice.kind) {
    case "change":
      return (
        <button className={className} disabled={disabled} onClick={() => onChangePlan(choice.planId)} type="button">
          {choice.label}
        </button>
      );
    case "contact":
      return (
        <a className={className} href={choice.url} rel="noreferrer" target="_blank">
          {choice.label}
          <ArrowUpRightIcon aria-hidden="true" size={14} />
        </a>
      );
    case "current":
      return <button className={className} disabled type="button">Current plan</button>;
    case "scheduled":
      return <button className={className} disabled type="button">Starts next period</button>;
    case "unavailable":
      return null;
  }
}

function ComparisonTable({ catalog }: { catalog: PlanCatalog }) {
  return (
    <div className="billingPlans__tableWrap">
      <table className="billingPlans__table">
        <caption className="billingPlans__srOnly">Plan comparison</caption>
        <thead>
          <tr>
            <td />
            {catalog.plans.map((plan) => (
              <th key={plan.id} scope="col">
                <strong>{plan.name}</strong>
                <span>{`${plan.price}${plan.unit ? ` ${plan.unit}` : ""}`}</span>
              </th>
            ))}
          </tr>
        </thead>
        {catalog.comparison.map((group) => (
          <tbody key={group.title}>
            <tr className="billingPlans__group">
              <th colSpan={catalog.plans.length + 1} scope="rowgroup">{group.title}</th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">
                  {row.label}
                  {row.note ? <span>{row.note}</span> : null}
                </th>
                {catalog.plans.map((plan, index) => (
                  <td key={plan.id}>
                    <ComparisonValue value={row.values[index] ?? false} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

// A full-screen dialog with the plans side by side and what each includes,
// so a workspace can pick one and go to checkout from the billing page.
export function BillingPlans({
  billing,
  catalog,
  disabled,
  onChangePlan,
  onClose,
}: {
  billing: PlanBillingState;
  catalog: PlanCatalog;
  // Plans cannot change while a change is in progress or billing is not
  // configured.
  disabled: boolean;
  onChangePlan: (planId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [comparing, setComparing] = useState(false);
  useDialogFocusTrap(dialogRef, true);
  const recommended = recommendedPlanId(catalog, billing);
  const plans = upgradePlans(catalog).map((plan) => {
    const choice = planChoice(plan, billing);
    return {
      additions: planAdditions(catalog, plan.id),
      choice,
      note: planChoiceNote(choice, billing),
      plan,
      // The recommended plan leads; without one, upgrades do.
      primary: recommended === null ? choice.kind === "change" && choice.upgrade : plan.id === recommended,
    };
  });

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="billingPlans">
      <section
        aria-describedby="billing-plans-intro"
        aria-labelledby="billing-plans-title"
        aria-modal="true"
        className="billingPlans__dialog"
        id={BILLING_PLANS_ID}
        ref={dialogRef}
        role="dialog"
      >
        <button aria-label="Close plans" className="billingPlans__close" onClick={onClose} type="button">
          <XIcon aria-hidden="true" size={18} />
        </button>
        <header className="billingPlans__header">
          <h2 id="billing-plans-title">Choose a plan</h2>
          <p id="billing-plans-intro">{catalog.intro}</p>
        </header>

        <div className="billingPlans__cards" style={{ "--billing-plan-count": plans.length } as CSSProperties}>
          {plans.map(({ additions, choice, note, plan, primary }, index) => (
            <article
              aria-labelledby={`billing-plan-${plan.id}`}
              className={`billingPlans__card billingPlans__card--tone${index % 3}${plan.id === recommended ? " isRecommended" : ""}`}
              key={plan.id}
            >
              <div className="billingPlans__cardTop">
                <div className="billingPlans__cardHeading">
                  <span className="billingPlans__label">{plan.label}</span>
                  {choice.kind === "current" ? (
                    <span className="billingPlans__status">Current plan</span>
                  ) : plan.id === recommended ? (
                    <span className="billingPlans__status billingPlans__status--accent">Recommended</span>
                  ) : null}
                </div>
                <h3 id={`billing-plan-${plan.id}`}>{plan.name}</h3>
                <p className="billingPlans__price">
                  <strong>{plan.price}</strong>
                  {plan.unit ? <small>{plan.unit}</small> : null}
                </p>
                <p className="billingPlans__audience">{plan.audience}</p>
                <span className="billingPlans__badge">{plan.badge}</span>
                <PlanAction choice={choice} disabled={disabled} onChangePlan={onChangePlan} primary={primary} />
                <p className="billingPlans__note">{note ?? " "}</p>
              </div>
              <div className="billingPlans__cardBody">
                <p className="billingPlans__description">{plan.description}</p>
                {additions.features.length > 0 ? (
                  <>
                    {additions.base ? <p className="billingPlans__base">{`Everything in ${additions.base}, plus`}</p> : null}
                    <ul className="billingPlans__features">
                      {additions.features.map((feature) => (
                        <li key={feature.label}>
                          <span>{feature.label}</span>
                          <strong>
                            <ComparisonValue value={feature.value} />
                          </strong>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        {catalog.comparison.length > 0 ? (
          <div className="billingPlans__more">
            <button
              aria-expanded={comparing}
              className="billingPlans__toggle"
              onClick={() => setComparing((value) => !value)}
              type="button"
            >
              Compare all features
              <CaretDownIcon aria-hidden="true" size={14} />
            </button>
            {comparing ? <ComparisonTable catalog={catalog} /> : null}
          </div>
        ) : null}

        {catalog.questions.length > 0 ? (
          <div className="billingPlans__questions">
            <h3>Questions</h3>
            <div>
              {catalog.questions.map((item) => (
                <details key={item.question}>
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
