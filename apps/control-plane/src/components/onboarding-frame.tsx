import type { ReactNode } from "react";
import { BellIcon, GitPullRequestIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { onboardingStepLabels, type OnboardingStep } from "../pages/onboarding-presentation";
import { ProviderGlyph } from "./icons";
import "./onboarding.css";

export type OnboardingStage = "alert" | "cause" | "fix";

// The setup card: progress across the steps, the step's content and actions,
// and, beside steps that connect tools, how Superlog uses them.
export function OnboardingFrame({
  activeStages,
  children,
  connected = [],
  footer,
  step,
  steps,
}: {
  // Stages of the explainer the current step enables. Without it the step
  // takes the full width.
  activeStages?: OnboardingStage[];
  children: ReactNode;
  connected?: readonly string[];
  footer: ReactNode;
  step: OnboardingStep;
  steps: readonly OnboardingStep[];
}) {
  const currentIndex = steps.indexOf(step);
  return (
    <main className="onboarding">
      <section className={`onboarding__card${activeStages ? "" : " onboarding__card--wide"}`}>
        <div className="onboarding__main">
          <ol aria-label="Setup progress" className="onboarding__steps">
            {steps.map((candidate, index) => (
              <li
                aria-current={candidate === step ? "step" : undefined}
                className={index < currentIndex ? "isComplete" : index === currentIndex ? "isCurrent" : undefined}
                key={candidate}
              >
                {onboardingStepLabels[candidate]}
              </li>
            ))}
          </ol>
          <div className="onboarding__content">{children}</div>
          <footer className="onboarding__footer">{footer}</footer>
        </div>
        {activeStages ? (
          <aside aria-label="How Superlog works" className="onboarding__aside">
            <HowItWorks activeStages={activeStages} connected={connected} />
          </aside>
        ) : null}
      </section>
    </main>
  );
}

const alertGlyphs = ["sentry", "datadog", "slack", "discord"] as const;

function HowItWorks({ activeStages, connected }: { activeStages: OnboardingStage[]; connected: readonly string[] }) {
  const stageClass = (stage: OnboardingStage) => `onboardingFlow__stage${activeStages.includes(stage) ? " isActive" : ""}`;
  const source = connected.includes("sentry") ? "Sentry" : connected.includes("datadog") ? "Datadog" : null;
  return (
    <ol className="onboardingFlow">
      <li className={stageClass("alert")}>
        <span className="onboardingFlow__icon"><BellIcon aria-hidden="true" size={16} /></span>
        <div>
          <strong>An alert comes in</strong>
          <span className="onboardingFlow__sources">
            {alertGlyphs.map((provider) => (
              <ProviderGlyph
                className={connected.includes(provider) ? "isConnected" : undefined}
                decorative
                key={provider}
                provider={provider}
              />
            ))}
          </span>
          <code className="onboardingFlow__error">TypeError in checkout.ts{source ? ` · ${source}` : ""}</code>
        </div>
      </li>
      <li className={stageClass("cause")}>
        <span className="onboardingFlow__icon"><MagnifyingGlassIcon aria-hidden="true" size={16} /></span>
        <div>
          <strong>Superlog finds the cause</strong>
          <p>Reads logs and code, finds the commit, and tests a fix</p>
        </div>
      </li>
      <li className={stageClass("fix")}>
        <span className="onboardingFlow__icon"><GitPullRequestIcon aria-hidden="true" size={16} /></span>
        <div>
          <strong>You get the fix</strong>
          <p>A plain summary in Slack and a pull request</p>
        </div>
      </li>
    </ol>
  );
}
