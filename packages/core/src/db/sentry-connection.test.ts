import { describe, expect, it } from "vitest";
import {
  SentryConnectionUnavailableError,
  SentryRefreshHttpError,
  sentryConnectionFailureDiagnostics,
} from "./investigations.js";

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
