import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissTelemetryCall,
  isTelemetryCallDismissed,
  telemetryCallDismissedStorageKey,
  telemetryCallUrl,
} from "./telemetry-call.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("telemetry call address", () => {
  it("is disabled unless a booking address is configured", () => {
    expect(telemetryCallUrl({} as ImportMetaEnv)).toBeNull();
    vi.stubEnv("VITE_TELEMETRY_CALL_URL", "  ");

    expect(telemetryCallUrl()).toBeNull();
  });

  it("returns a configured HTTPS booking address", () => {
    vi.stubEnv("VITE_TELEMETRY_CALL_URL", "https://cal.example/team/telemetry");

    expect(telemetryCallUrl()).toBe("https://cal.example/team/telemetry");
  });

  it("rejects insecure or malformed addresses", () => {
    vi.stubEnv("VITE_TELEMETRY_CALL_URL", "http://cal.example/team/telemetry");
    expect(telemetryCallUrl()).toBeNull();

    vi.stubEnv("VITE_TELEMETRY_CALL_URL", "javascript:alert(1)");
    expect(telemetryCallUrl()).toBeNull();

    vi.stubEnv("VITE_TELEMETRY_CALL_URL", "not a url");
    expect(telemetryCallUrl()).toBeNull();
  });
});

describe("telemetry call dismissal", () => {
  it("stays dismissed once closed", () => {
    const storage = memoryStorage();
    expect(isTelemetryCallDismissed(storage)).toBe(false);

    dismissTelemetryCall(storage);

    expect(storage.getItem(telemetryCallDismissedStorageKey)).toBe("1");
    expect(isTelemetryCallDismissed(storage)).toBe(true);
  });

  it("shows the card when storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(isTelemetryCallDismissed(storage)).toBe(false);
    expect(() => dismissTelemetryCall(storage)).not.toThrow();
    expect(isTelemetryCallDismissed(null)).toBe(false);
  });
});
