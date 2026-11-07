import { useEffect, useSyncExternalStore } from "react";
import { fetchSignalSettings, type SignalSettings } from "./model";

// Whether the active workspace finished Signal setup, shared by the sidebar
// and Signal's pages. Until it has, a workspace sees only setup.
export type SignalSetupState = "loading" | "incomplete" | "complete" | "unknown";

let current: { organizationId: string; state: SignalSetupState } | null = null;
// Counts publications, so a load can tell that newer settings arrived while
// it was in flight.
let version = 0;
const listeners = new Set<() => void>();
const requests = new Map<string, Promise<void>>();

function publish(organizationId: string, state: SignalSetupState) {
  version += 1;
  current = { organizationId, state };
  for (const listener of listeners) listener();
}

// Setup is complete once Signal has been turned on; turning it off later
// keeps past findings reachable. Older servers only report `enabled`.
export function setupComplete(settings: Pick<SignalSettings, "enabled" | "setupComplete">) {
  return settings.setupComplete ?? settings.enabled;
}

// Loads the state once at a time per workspace; concurrent callers share the
// request. A retry shows loading while it runs. A result is dropped when
// newer settings were published meanwhile, such as by a save.
export function loadSignalSetupState(organizationId: string, options: { retry?: boolean } = {}): Promise<void> {
  const pending = requests.get(organizationId);
  if (pending) return pending;
  if (options.retry) publish(organizationId, "loading");
  const started = version;
  const request = fetchSignalSettings()
    .then((settings) => { if (version === started) publishSignalSettings(organizationId, settings); })
    .catch(() => { if (version === started) publish(organizationId, "unknown"); })
    .finally(() => requests.delete(organizationId));
  requests.set(organizationId, request);
  return request;
}

// Settings loaded or saved elsewhere, such as on the setup page.
export function publishSignalSettings(organizationId: string, settings: Pick<SignalSettings, "enabled" | "setupComplete">) {
  // An older server reports only `enabled`; a setup already known to be
  // complete stays complete when Signal is turned off.
  const alreadyComplete = settings.setupComplete === undefined &&
    current?.organizationId === organizationId && current.state === "complete";
  publish(organizationId, alreadyComplete || setupComplete(settings) ? "complete" : "incomplete");
}

export function signalSetupSnapshot() {
  return current;
}

// For tests: forget what was loaded.
export function resetSignalSetupState() {
  current = null;
  version = 0;
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
    if (signal && organizationId && !known) void loadSignalSetupState(organizationId);
  }, [signal, organizationId, known]);
  if (!signal || !organizationId) return null;
  return known ? snapshot!.state : "loading";
}
