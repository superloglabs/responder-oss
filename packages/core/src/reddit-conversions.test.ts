import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

function stubCredentials() {
  vi.stubEnv("REDDIT_ADS_CONVERSION_TOKEN", "conversion-token");
  vi.stubEnv("REDDIT_ADS_PIXEL_ID", "a2_pixel123");
  vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example/app");
}

describe("Reddit signup conversions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("canonicalizes email addresses for Reddit hashing", async () => {
    const { canonicalizeRedditEmail } = await import(
      "./reddit-conversions.js"
    );

    expect(canonicalizeRedditEmail(" Al.ice+Offer@Example.COM ")).toBe(
      "alice@example.com",
    );
    expect(canonicalizeRedditEmail("invalid")).toBeNull();
  });

  it("is disabled when credentials are absent", async () => {
    const { captureRedditSignupConversion } = await import(
      "./reddit-conversions.js"
    );

    await captureRedditSignupConversion({
      conversionId: "user-1",
      email: "user@example.com",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is disabled when the pixel id is malformed", async () => {
    stubCredentials();
    vi.stubEnv("REDDIT_ADS_PIXEL_ID", "invalid-pixel");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureRedditSignupConversion } = await import(
      "./reddit-conversions.js"
    );

    await captureRedditSignupConversion({
      conversionId: "user-1",
      email: "user@example.com",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      'REDDIT_ADS_PIXEL_ID must look like a2_xxxxx, got "invalid-pixel"',
    );
    consoleError.mockRestore();
  });

  it("sends a deduplicated signup with hashed match keys", async () => {
    stubCredentials();
    vi.spyOn(Date, "now").mockReturnValue(1_789_489_173_570);
    const { captureRedditSignupConversion } = await import(
      "./reddit-conversions.js"
    );

    await captureRedditSignupConversion({
      clickId: "reddit-click-1",
      conversionId: "user-1",
      email: " Al.ice+Offer@Example.COM ",
      ipAddress: "203.0.113.5",
      userAgent: "Responder Browser",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://ads-api.reddit.com/api/v3/pixels/a2_pixel123/conversion_events",
    );
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({
      Authorization: "Bearer conversion-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(request.body as string)).toEqual({
      data: {
        events: [
          {
            action_source: "WEBSITE",
            click_id: "reddit-click-1",
            event_at: 1_789_489_173_570,
            event_source_url: "https://responder.example",
            metadata: { conversion_id: "user-1" },
            type: { tracking_type: "SIGN_UP" },
            user: {
              email: createHash("sha256")
                .update("alice@example.com")
                .digest("hex"),
              external_id: createHash("sha256")
                .update("user-1")
                .digest("hex"),
              ip_address: "203.0.113.5",
              user_agent: "Responder Browser",
            },
          },
        ],
      },
    });
  });

  it("omits invalid optional match keys", async () => {
    stubCredentials();
    const { captureRedditSignupConversion } = await import(
      "./reddit-conversions.js"
    );

    await captureRedditSignupConversion({
      clickId: "bad; click id",
      conversionId: "user-1",
      email: "user@example.com",
      ipAddress: "not-an-ip",
    });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const event = JSON.parse(request.body as string).data.events[0];
    expect(event).not.toHaveProperty("click_id");
    expect(event.user).not.toHaveProperty("ip_address");
  });

  it("does not fail signup when delivery fails", async () => {
    stubCredentials();
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureRedditSignupConversion } = await import(
      "./reddit-conversions.js"
    );

    await expect(
      captureRedditSignupConversion({
        conversionId: "user-1",
        email: "user@example.com",
      }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "Unable to capture Reddit signup conversion: Reddit Ads API responded with status 401",
    );
    consoleError.mockRestore();
  });
});
