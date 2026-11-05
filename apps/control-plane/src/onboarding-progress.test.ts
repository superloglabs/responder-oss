import { describe, expect, it } from "vitest";
import {
  onboardingProgressStorageKey,
  onboardingResume,
  readOnboardingProgress,
  updateOnboardingProgress,
} from "./onboarding-progress";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const withTelemetry = ["automations", "telemetry"];

describe("onboarding progress", () => {
  it("records the step each workspace was left on", () => {
    const storage = memoryStorage();
    updateOnboardingProgress("org-a", { step: "telemetry" }, storage);
    updateOnboardingProgress("org-b", { step: "usage" }, storage);
    expect(readOnboardingProgress("org-a", storage)).toEqual({ dismissed: false, finished: false, step: "telemetry" });
    expect(readOnboardingProgress("org-b", storage)?.step).toBe("usage");
    expect(readOnboardingProgress("org-c", storage)).toBeNull();
  });

  it("keeps the step when setup is finished or dismissed", () => {
    const storage = memoryStorage();
    updateOnboardingProgress("org-a", { step: "alerts" }, storage);
    updateOnboardingProgress("org-a", { dismissed: true }, storage);
    expect(readOnboardingProgress("org-a", storage)).toEqual({ dismissed: true, finished: false, step: "alerts" });
  });

  it("needs a step before anything else is recorded", () => {
    const storage = memoryStorage();
    updateOnboardingProgress("org-a", { finished: true }, storage);
    expect(readOnboardingProgress("org-a", storage)).toBeNull();
  });

  it("ignores stored values it cannot read", () => {
    expect(readOnboardingProgress("org-a", memoryStorage({ [onboardingProgressStorageKey]: "not json" }))).toBeNull();
    expect(readOnboardingProgress("org-a", memoryStorage({
      [onboardingProgressStorageKey]: JSON.stringify({ "org-a": { step: "workspace" } }),
    }))).toBeNull();
    expect(readOnboardingProgress("org-a", null)).toBeNull();
  });
});

describe("onboardingResume", () => {
  it("reopens setup at the recorded step", () => {
    expect(onboardingResume({ step: "telemetry" }, withTelemetry)).toEqual({
      label: "Telemetry",
      number: 3,
      path: "/onboarding/telemetry",
      total: 6,
    });
  });

  it("moves past a step the workspace does not offer", () => {
    expect(onboardingResume({ step: "telemetry" }, ["automations"])).toEqual({
      label: "Alerts",
      number: 3,
      path: "/onboarding/alerts",
      total: 5,
    });
  });

  it("hides once setup is finished or dismissed, or without automations", () => {
    expect(onboardingResume({ finished: true, step: "templates" }, withTelemetry)).toBeNull();
    expect(onboardingResume({ dismissed: true, step: "code" }, withTelemetry)).toBeNull();
    expect(onboardingResume({ step: "code" }, ["telemetry"])).toBeNull();
    expect(onboardingResume(null, withTelemetry)).toBeNull();
  });
});
