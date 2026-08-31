import { describe, expect, it } from "vitest";
import {
  daytonaClientOptions,
  isDaytonaNotFound,
  requireDaytonaClientConfig,
} from "./daytona-config.js";

describe("Daytona client configuration", () => {
  it("omits blank optional settings", () => {
    expect(
      requireDaytonaClientConfig({
        DAYTONA_API_KEY: "api-key",
        DAYTONA_SANDBOX_SNAPSHOT_NAME: "snapshot-name",
        DAYTONA_API_URL: " ",
        DAYTONA_TARGET: "",
      }),
    ).toEqual({
      daytonaApiKey: "api-key",
      daytonaApiUrl: undefined,
      daytonaTarget: undefined,
      sandboxSnapshotName: "snapshot-name",
    });
  });

  it("accepts an absolute HTTPS API URL", () => {
    expect(
      requireDaytonaClientConfig({
        DAYTONA_API_KEY: "api-key",
        DAYTONA_SANDBOX_SNAPSHOT_NAME: "snapshot-name",
        DAYTONA_API_URL: " https://daytona.example.test:8443/api ",
      }).daytonaApiUrl,
    ).toBe("https://daytona.example.test:8443/api");
  });

  it("passes the configured snapshot to Daytona clients", () => {
    expect(
      daytonaClientOptions({
        daytonaApiKey: "api-key",
        sandboxSnapshotName: "snapshot-name",
      }),
    ).toEqual({
      apiKey: "api-key",
      apiUrl: undefined,
      sandboxSnapshotName: "snapshot-name",
      target: undefined,
    });
  });

  it.each([
    "http://daytona.example.test",
    "daytona.example.test",
    "/api",
  ])("rejects a non-HTTPS or relative API URL: %s", (daytonaApiUrl) => {
    expect(() =>
      requireDaytonaClientConfig({
        DAYTONA_API_KEY: "api-key",
        DAYTONA_SANDBOX_SNAPSHOT_NAME: "snapshot-name",
        DAYTONA_API_URL: daytonaApiUrl,
      }),
    ).toThrow("DAYTONA_API_URL must be an absolute HTTPS URL");
  });

  it("rejects credentials, fragments, and query parameters in the API URL", () => {
    expect(() =>
      requireDaytonaClientConfig({
        DAYTONA_API_KEY: "api-key",
        DAYTONA_SANDBOX_SNAPSHOT_NAME: "snapshot-name",
        DAYTONA_API_URL: "https://user:password@daytona.example.test/api",
      }),
    ).toThrow("DAYTONA_API_URL cannot contain credentials");
    expect(() =>
      requireDaytonaClientConfig({
        DAYTONA_API_KEY: "api-key",
        DAYTONA_SANDBOX_SNAPSHOT_NAME: "snapshot-name",
        DAYTONA_API_URL: "https://daytona.example.test/api#ignored",
      }),
    ).toThrow("DAYTONA_API_URL cannot contain a fragment");
    expect(() =>
      requireDaytonaClientConfig({
        DAYTONA_API_KEY: "api-key",
        DAYTONA_SANDBOX_SNAPSHOT_NAME: "snapshot-name",
        DAYTONA_API_URL:
          "https://daytona.example.test/api?access_token=secret",
      }),
    ).toThrow("DAYTONA_API_URL cannot contain query parameters");
  });

  it("recognizes not-found errors across package boundaries", () => {
    const namedError = new Error("missing");
    namedError.name = "DaytonaNotFoundError";

    expect(isDaytonaNotFound(namedError)).toBe(true);
    expect(isDaytonaNotFound({ statusCode: 404 })).toBe(true);
    expect(isDaytonaNotFound({ statusCode: 500 })).toBe(false);
  });
});
