import { useEffect, useSyncExternalStore } from "react";
import { fetchSignalSettings, type SignalSettings } from "./model";

// Whether the active workspace finished Signal setup, shared by the sidebar
// and Signal's pages. Until it has, a workspace sees only setup.
export type SignalSetupState = "loading" | "incomplete" | "complete" | "unknown";

let current: { organizationId: string; state: SignalSetupState } | null = null;
const listeners = new Set<() => void>();
const requests = new Map<string, Promise<void>>();

function publish(organizationId: string, state: SignalSetupState) {
  current = { organizationId, state };
  for (const listener of listeners) listener();
}

// Setup is complete once Signal has been turned on; turning it off later
// keeps past findings reachable. Older servers only report `enabled`.
export function setupComplete(settings: Pick<SignalSettings, "enabled" | "setupComplete">) {
  return settings.setupComplete ?? settings.enabled;
}

function load(organizationId: string) {
  if (requests.has(organizationId)) return;
  const request = fetchSignalSettings()
    .then((settings) => publish(organizationId, setupComplete(settings) ? "complete" : "incomplete"))
    .catch(() => publish(organizationId, "unknown"))
    .finally(() => requests.delete(organizationId));
  requests.set(organizationId, request);
}

export function markSignalSetupComplete(organizationId: string) {
  publish(organizationId, "complete");
}

// For tests: forget what was loaded.
export function resetSignalSetupState() {
  current = null;
  requests.clear();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Loads the state for a workspace with Signal; other workspaces get null.
export function useSignalSetupState(organizationId: string | null | undefined, signal: boolean): SignalSetupState | null {
  const snapshot = useSyncExternalStore(subscribe, () => current, () => null);
  const known = Boolean(signal && organizationId && snapshot?.organizationId === organizationId);
  useEffect(() => {
    if (signal && organizationId && !known) load(organizationId);
  }, [signal, organizationId, known]);
  if (!signal || !organizationId) return null;
  return known ? snapshot!.state : "loading";
}
