import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { onboardingResume, readOnboardingProgress, updateOnboardingProgress } from "../onboarding-progress";

// Reopens guided setup at the step the member left it on, until setup is
// finished or the card is dismissed.
export function OnboardingResumeCard({
  capabilities,
  organizationId,
}: {
  capabilities: readonly string[];
  organizationId: string | null | undefined;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!organizationId || dismissed === organizationId) return null;
  const resume = onboardingResume(readOnboardingProgress(organizationId), capabilities);
  if (!resume) return null;

  return (
    <aside aria-labelledby="onboarding-resume-title" className="onboardingResume">
      <button
        aria-label="Dismiss setup"
        className="onboardingResume__dismiss"
        onClick={() => {
          updateOnboardingProgress(organizationId, { dismissed: true });
          setDismissed(organizationId);
        }}
        type="button"
      >
        <XIcon aria-hidden="true" size={12} />
      </button>
      <h2 className="onboardingResume__title" id="onboarding-resume-title">Finish setting up</h2>
      <p className="onboardingResume__body">
        Step {resume.number} of {resume.total}: {resume.label}
      </p>
      <span
        aria-hidden="true"
        className="onboardingResume__bar"
      >
        {Array.from({ length: resume.total }, (_, index) => (
          <span className={index < resume.number - 1 ? "isComplete" : undefined} key={index} />
        ))}
      </span>
      <Link className="onboardingResume__action" to={resume.path}>
        Resume setup <span aria-hidden="true">→</span>
      </Link>
    </aside>
  );
}
