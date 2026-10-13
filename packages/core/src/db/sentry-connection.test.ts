import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "../credentials/encryption.js";
import {
  SentryConnectionUnavailableError,
  SentryRefreshHttpError,
  freshSentryCredentials,
  sentryConnectionFailureDiagnostics,
} from "./investigations.js";

vi.mock("./integrations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./integrations.js")>()),
  withIntegrationAccountCredentialLease: vi.fn(
    async (input: {
      operation: (encryptedCredentials: string) => Promise<{ value: unknown }>;
    }) => (await input.operation(storedCredentials)).value,
  ),
}));

let storedCredentials = "";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("freshSentryCredentials", () => {
  it("recovers when Sentry already rotated the stored refresh token", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("SENTRY_CLIENT_ID", "sentry-client");
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    storedCredentials = encryptCredentials({
      accessToken: "expired-token",
      expiresAt: "2026-10-07T00:00:00Z",
      installationId: "40000000-0000-4000-8000-000000000000",
      refreshToken: "rotated-refresh-token",
    });
    // The refresh that rotated the token timed out, so the stored token is
    // already revoked.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          token: "fresh-token",
          refreshToken: "fresh-refresh-token",
          expiresAt: "2026-10-07T08:00:00Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      freshSentryCredentials({
        encryptedCredentials: storedCredentials,
        integrationAccountId: "30000000-0000-4000-8000-000000000000",
        organizationId: "10000000-0000-4000-8000-000000000000",
      }),
    ).resolves.toEqual({
      accessToken: "fresh-token",
      expiresAt: "2026-10-07T08:00:00Z",
      installationId: "40000000-0000-4000-8000-000000000000",
      refreshToken: "fresh-refresh-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Sentry connection failure diagnostics", () => {
  it("identifies request timeouts without recording secret-bearing messages", () => {
    const diagnostics = sentryConnectionFailureDiagnostics(
      new DOMException("The operation was aborted", "TimeoutError"),
      10_004,
    );

    expect(diagnostics).toEqual({
      errorCode: "TimeoutError",
      failureKind: "timeout",
      requestDurationMs: 10_004,
      retryable: true,
    });
  });

  it("preserves safe nested network error codes", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect timed out"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });

    expect(sentryConnectionFailureDiagnostics(error, 10_001)).toEqual({
      errorCode: "UND_ERR_CONNECT_TIMEOUT",
      failureKind: "timeout",
      requestDurationMs: 10_001,
      retryable: true,
    });
  });

  it("does not log arbitrary nested error codes", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("request failed"), {
        code: "customer-token-value",
      }),
    });

    expect(sentryConnectionFailureDiagnostics(error, 12)).toEqual({
      errorCode: "TypeError",
      failureKind: "network",
      requestDurationMs: 12,
      retryable: true,
    });
  });

  it.each([
    { httpStatus: 401, retryable: false },
    { httpStatus: 429, retryable: true },
    { httpStatus: 503, retryable: true },
  ])("classifies HTTP $httpStatus refresh failures", ({ httpStatus, retryable }) => {
    expect(
      sentryConnectionFailureDiagnostics(
        new SentryRefreshHttpError(httpStatus),
        245,
      ),
    ).toEqual({
      errorCode: "SentryRefreshHttpError",
      failureKind: "http",
      httpStatus,
      requestDurationMs: 245,
      retryable,
    });
  });

  it("preserves the original failure as the monitored cause", () => {
    const cause = new DOMException("The operation was aborted", "TimeoutError");
    const diagnostics = sentryConnectionFailureDiagnostics(cause, 10_002);
    const error = new SentryConnectionUnavailableError(diagnostics, cause);

    expect(error).toMatchObject({
      cause,
      errorCode: "TimeoutError",
      failureKind: "timeout",
      message: "Unable to refresh Sentry access",
      name: "SentryConnectionUnavailableError",
      requestDurationMs: 10_002,
      retryable: true,
    });
  });
});
