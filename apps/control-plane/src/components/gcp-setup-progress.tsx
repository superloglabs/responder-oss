import { GCP_SETUP_STEPS, type GcpSetupStatus } from "../gcp-setup-status";

export function GcpSetupStepper({ setup }: { setup: GcpSetupStatus }) {
  const currentIndex = GCP_SETUP_STEPS.findIndex((step) => step.id === setup.step);
  return (
    <ol className="gcpSetupSteps" aria-label="Google Cloud setup progress">
      {GCP_SETUP_STEPS.map((step, index) => {
        const state = setup.status === "succeeded" || index < currentIndex
          ? "isComplete"
          : index === currentIndex
            ? setup.status === "failed" ? "isFailed" : "isCurrent"
            : "isPending";
        return (
          <li
            aria-current={state === "isCurrent" ? "step" : undefined}
            className={`gcpSetupSteps__step ${state}`}
            key={step.id}
          >
            <span aria-hidden="true" className="gcpSetupSteps__marker">
              {state === "isComplete" ? "✓" : state === "isFailed" ? "!" : index + 1}
            </span>
            <span>{state === "isCurrent" ? step.progress : step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
