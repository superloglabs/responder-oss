import {
  onboardingPath,
  onboardingStepLabels,
  onboardingSteps,
  onboardingStepsFor,
  type OnboardingStep,
} from "./pages/onboarding-presentation";

// Where each workspace's guided setup stopped, kept in this browser. Setup
// records the step it shows, so a member who skips ahead can reopen it from
// the sidebar at that step. Members who never opened setup in this browser,
// such as invited teammates, have no record and see no sidebar card.
export const onboardingProgressStorageKey = "superlog-onboarding-progress";

export type SetupStep = Exclude<OnboardingStep, "workspace">;

export interface OnboardingProgress {
  // The member closed the sidebar card.
  dismissed?: boolean;
  // The member reached the end of setup.
  finished?: boolean;
  step: SetupStep;
}

type ProgressStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): ProgressStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === "string" && value !== "workspace" && (onboardingSteps as readonly string[]).includes(value);
}

function readAll(storage: ProgressStorage | null): Record<string, OnboardingProgress> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(onboardingProgressStorageKey) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).flatMap(([organizationId, value]) => {
      if (!value || typeof value !== "object") return [];
      const { dismissed, finished, step } = value as Record<string, unknown>;
      if (!isSetupStep(step)) return [];
      return [[organizationId, { dismissed: dismissed === true, finished: finished === true, step }] as const];
    });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function readOnboardingProgress(
  organizationId: string,
  storage: ProgressStorage | null = browserStorage(),
): OnboardingProgress | null {
  return readAll(storage)[organizationId] ?? null;
}

// Records a change for the workspace. A workspace without a record needs a
// step first. Without storage, setup still works but the sidebar cannot
// reopen it.
export function updateOnboardingProgress(
  organizationId: string,
  change: Partial<OnboardingProgress>,
  storage: ProgressStorage | null = browserStorage(),
) {
  const all = readAll(storage);
  const current = all[organizationId];
  const step = change.step ?? current?.step;
  if (!step) return;
  all[organizationId] = { ...current, ...change, step };
  try {
    storage?.setItem(onboardingProgressStorageKey, JSON.stringify(all));
  } catch {
    // Storage is full or blocked; the card stays as it was.
  }
}

export interface OnboardingResume {
  label: string;
  // The step's position in the progress bar, counting the workspace step.
  number: number;
  path: string;
  total: number;
}

// Where the sidebar reopens setup, or null when setup is finished, dismissed,
// or not offered to the workspace. A recorded step the workspace no longer
// lists, such as telemetry after the capability is turned off, resumes at
// the next step it does list.
export function onboardingResume(
  progress: OnboardingProgress | null,
  capabilities: readonly string[],
): OnboardingResume | null {
  if (!progress || progress.dismissed || progress.finished || !capabilities.includes("automations")) return null;
  const steps = onboardingStepsFor(capabilities);
  const position = onboardingSteps.indexOf(progress.step);
  const step = steps.find((candidate) => onboardingSteps.indexOf(candidate) >= position);
  if (!isSetupStep(step)) return null;
  return {
    label: onboardingStepLabels[step],
    number: steps.indexOf(step) + 1,
    path: onboardingPath(step),
    total: steps.length,
  };
}
