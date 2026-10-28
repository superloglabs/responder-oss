// Hosted deployments invite members to book a call about storing their
// telemetry in the product. The card stays hidden unless the booking address
// is configured, and once dismissed it stays hidden in that browser.
export const telemetryCallDismissedStorageKey = "superlog-telemetry-call-dismissed";

type DismissalStorage = Pick<Storage, "getItem" | "setItem">;

export function telemetryCallUrl(
  environment: ImportMetaEnv = import.meta.env,
): string | null {
  const value = environment.VITE_TELEMETRY_CALL_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function browserStorage(): DismissalStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isTelemetryCallDismissed(
  storage: DismissalStorage | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(telemetryCallDismissedStorageKey) === "1";
  } catch {
    return false;
  }
}

export function dismissTelemetryCall(
  storage: DismissalStorage | null = browserStorage(),
) {
  try {
    storage?.setItem(telemetryCallDismissedStorageKey, "1");
  } catch {
    // Without storage the card stays hidden until the page reloads.
  }
}
