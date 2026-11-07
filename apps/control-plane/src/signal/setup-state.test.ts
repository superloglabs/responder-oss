import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchSignalSettings = vi.hoisted(() => vi.fn());
vi.mock("./model", () => ({ fetchSignalSettings }));

import {
  loadSignalSetupState,
  publishSignalSettings,
  resetSignalSetupState,
  signalSetupSnapshot,
} from "./setup-state";

describe("Signal setup state", () => {
  beforeEach(() => {
    resetSignalSetupState();
    fetchSignalSettings.mockReset();
  });

  it("is complete or incomplete from the workspace's settings", async () => {
    fetchSignalSettings.mockResolvedValueOnce({ enabled: false, setupComplete: true });
    await loadSignalSetupState("org-a");
    expect(signalSetupSnapshot()).toEqual({ organizationId: "org-a", state: "complete" });
    fetchSignalSettings.mockResolvedValueOnce({ enabled: false, setupComplete: false });
    await loadSignalSetupState("org-b");
    expect(signalSetupSnapshot()).toEqual({ organizationId: "org-b", state: "incomplete" });
  });

  it("is unknown when the lookup fails, and loads again when asked", async () => {
    fetchSignalSettings.mockRejectedValueOnce(new Error("unavailable"));
    await loadSignalSetupState("org-a");
    expect(signalSetupSnapshot()?.state).toBe("unknown");
    fetchSignalSettings.mockResolvedValueOnce({ enabled: true });
    await loadSignalSetupState("org-a");
    expect(signalSetupSnapshot()?.state).toBe("complete");
  });

  it("shares one request between concurrent loads", async () => {
    fetchSignalSettings.mockResolvedValue({ enabled: true });
    await Promise.all([loadSignalSetupState("org-a"), loadSignalSetupState("org-a")]);
    expect(fetchSignalSettings).toHaveBeenCalledTimes(1);
  });

  it("takes settings loaded or saved elsewhere", () => {
    publishSignalSettings("org-a", { enabled: false, setupComplete: false });
    expect(signalSetupSnapshot()?.state).toBe("incomplete");
    publishSignalSettings("org-a", { enabled: true, setupComplete: true });
    expect(signalSetupSnapshot()?.state).toBe("complete");
  });
});
