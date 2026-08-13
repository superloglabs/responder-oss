import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

function stubCredentials() {
  vi.stubEnv("X_ADS_CONSUMER_KEY", "consumer-key");
  vi.stubEnv("X_ADS_CONSUMER_SECRET", "consumer-secret");
  vi.stubEnv("X_ADS_ACCESS_TOKEN", "access-token");
  vi.stubEnv("X_ADS_ACCESS_TOKEN_SECRET", "access-token-secret");
  vi.stubEnv("X_ADS_SIGNUP_EVENT_ID", "tw-pixel1-event1");
}

describe("X signup conversions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is disabled when credentials are absent", async () => {
    const { captureXSignupConversion } = await import("./x-conversions.js");

    await captureXSignupConversion({
      conversionId: "user-1",
      email: "user@example.com",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is disabled when the event id is malformed", async () => {
    stubCredentials();
    vi.stubEnv("X_ADS_SIGNUP_EVENT_ID", "invalid-event-id");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureXSignupConversion } = await import("./x-conversions.js");

    await captureXSignupConversion({
      conversionId: "user-1",
      email: "user@example.com",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      'X_ADS_SIGNUP_EVENT_ID must look like tw-xxxxx-yyyyy, got "invalid-event-id"',
    );
    consoleError.mockRestore();
  });

  it("skips conversions that have no identifier", async () => {
    stubCredentials();
    const { captureXSignupConversion } = await import("./x-conversions.js");

    await captureXSignupConversion({ conversionId: "user-1" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a signed conversion with hashed email and click id", async () => {
    stubCredentials();
    const { captureXSignupConversion } = await import("./x-conversions.js");

    await captureXSignupConversion({
      conversionId: "user-1",
      email: "  User@Example.COM ",
      twclid: "26l6412g5p4iyj65a2oic2ayg2",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ads-api.x.com/12/measurement/conversions/pixel1");
    expect(request.method).toBe("POST");

    const headers = request.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toMatch(/^OAuth /);
    expect(headers.Authorization).toContain('oauth_consumer_key="consumer-key"');
    expect(headers.Authorization).toContain('oauth_token="access-token"');
    expect(headers.Authorization).toContain(
      'oauth_signature_method="HMAC-SHA1"',
    );
    expect(headers.Authorization).toMatch(/oauth_signature="[^"]+"/);

    const body = JSON.parse(request.body as string);
    expect(body.conversions).toHaveLength(1);
    const conversion = body.conversions[0];
    expect(conversion.conversion_id).toBe("user-1");
    expect(conversion.event_id).toBe("tw-pixel1-event1");
    expect(Date.parse(conversion.conversion_time)).not.toBeNaN();
    expect(conversion.identifiers).toEqual([
      {
        hashed_email: createHash("sha256")
          .update("user@example.com")
          .digest("hex"),
      },
      { twclid: "26l6412g5p4iyj65a2oic2ayg2" },
    ]);
  });

  it("does not fail the signup when delivery fails", async () => {
    stubCredentials();
    fetchMock.mockRejectedValue(new Error("offline"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureXSignupConversion } = await import("./x-conversions.js");

    await expect(
      captureXSignupConversion({
        conversionId: "user-1",
        email: "user@example.com",
      }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "Unable to capture X signup conversion: offline",
    );
    consoleError.mockRestore();
  });

  it("does not fail the signup when the API rejects the conversion", async () => {
    stubCredentials();
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureXSignupConversion } = await import("./x-conversions.js");

    await expect(
      captureXSignupConversion({
        conversionId: "user-1",
        email: "user@example.com",
      }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "Unable to capture X signup conversion: X Ads API responded with status 401",
    );
    consoleError.mockRestore();
  });
});
