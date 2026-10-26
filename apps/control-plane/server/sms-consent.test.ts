import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordSmsConsent } from "../../../packages/core/src/db/sms-consents.js";
import { app } from "./app.js";
import {
  maskIpAddress,
  normalizeUsPhoneNumber,
  smsConsentSchema,
} from "./sms-consent.js";

vi.mock("../../../packages/core/src/db/sms-consents.js", () => ({
  recordSmsConsent: vi.fn(),
}));

const consentText =
  "I agree to receive text messages from Superlog about my account. Message and data rates may apply. Reply STOP to opt out.";
const formWithoutPageUrl = {
  consent: true,
  consentText,
  email: "  Ada@Example.COM ",
  name: "  Ada Lovelace ",
  phone: "(415) 555-0123",
};
const form = { ...formWithoutPageUrl, pageUrl: "https://responder.example/sms" };
let sequence = 0;
let clientIp = "";

function submit(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request("/api/sms-consent", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "https://responder.example",
      "user-agent": "Mozilla/5.0 (Macintosh)",
      "x-responder-client-ip": clientIp,
      ...headers,
    },
    method: "POST",
  });
}

describe("US phone numbers", () => {
  it("accepts common US formats and returns E.164", () => {
    for (const phone of [
      "(415) 555-0123",
      "415-555-0123",
      "415.555.0123",
      "4155550123",
      "+1 415 555 0123",
      "+1 (415) 555-0123",
      "+14155550123",
      "1-415-555-0123",
      " 415 555 0123 ",
    ]) {
      expect(normalizeUsPhoneNumber(phone)).toBe("+14155550123");
    }
  });

  it("rejects numbers that are not ten-digit US numbers", () => {
    for (const phone of [
      "",
      "555-0123",
      "415-555-012",
      "415-555-01234",
      "+4155550123",
      "+44 20 7946 0958",
      "+52 55 1234 5678",
      "2-415-555-0123",
      "(015) 555-0123",
      "(415) 155-0123",
      "415-555-0123 ext 4",
      "415-555-0123x4",
      "++1 415 555 0123",
      "+1 415 555 0123 +",
    ]) {
      expect(normalizeUsPhoneNumber(phone)).toBeNull();
    }
  });
});

describe("IP address masking", () => {
  it("zeroes the last IPv4 octet", () => {
    expect(maskIpAddress("203.0.113.45")).toBe("203.0.113.0");
    expect(maskIpAddress("203.0.113.45, 198.51.100.7")).toBe("203.0.113.0");
    expect(maskIpAddress("::ffff:203.0.113.45")).toBe("::ffff:203.0.113.0");
  });

  it("keeps only the first 48 bits of an IPv6 address", () => {
    expect(maskIpAddress("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe(
      "2001:db8:85a3::",
    );
    expect(maskIpAddress("2001:0DB8:0000:0001::7")).toBe("2001:db8::");
    expect(maskIpAddress("fe80::1")).toBe("fe80::");
    expect(maskIpAddress("::1")).toBe("::");
  });

  it("stores nothing for a missing or malformed address", () => {
    expect(maskIpAddress(undefined)).toBeNull();
    expect(maskIpAddress("")).toBeNull();
    expect(maskIpAddress("not an address")).toBeNull();
    expect(maskIpAddress("203.0.113")).toBeNull();
  });
});

describe("SMS consent validation", () => {
  function firstError(overrides: Record<string, unknown>) {
    const result = smsConsentSchema.safeParse({ ...form, ...overrides });
    return result.success ? null : result.error.issues[0]?.message;
  }

  it("trims the name, lowercases the email, and normalizes the phone", () => {
    expect(smsConsentSchema.parse(form)).toEqual({
      consent: true,
      consentText,
      email: "ada@example.com",
      name: "Ada Lovelace",
      pageUrl: "https://responder.example/sms",
      phone: "+14155550123",
    });
  });

  it("allows the page address to be left out", () => {
    expect(smsConsentSchema.parse(formWithoutPageUrl).pageUrl).toBeUndefined();
  });

  it("explains each invalid field", () => {
    expect(firstError({ name: "   " })).toBe("Enter your name");
    expect(firstError({ name: "a".repeat(201) })).toBe(
      "Use at most 200 characters for your name",
    );
    expect(firstError({ email: "ada@" })).toBe("Enter a valid email address");
    expect(firstError({ email: undefined })).toBe("Enter your email address");
    expect(firstError({ phone: "+44 20 7946 0958" })).toBe(
      "Enter a 10-digit US mobile number",
    );
    expect(firstError({ phone: undefined })).toBe("Enter your mobile number");
    expect(firstError({ consentText: "" })).toBe(
      "The consent wording is missing",
    );
    expect(firstError({ consentText: "a".repeat(2_001) })).toBe(
      "The consent wording is too long",
    );
    expect(firstError({ pageUrl: `https://x.example/${"a".repeat(500)}` })).toBe(
      "The page address is too long",
    );
  });

  it("requires the consent box to be literally true", () => {
    for (const consent of [false, "true", 1, undefined]) {
      expect(firstError({ consent })).toBe(
        "Check the box to agree to receive text messages",
      );
    }
  });
});

describe("POST /api/sms-consent", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "");
    // The rate limiter lives for the module, so each test uses its own
    // address.
    sequence += 1;
    clientIp = `198.51.100.${sequence}`;
    vi.mocked(recordSmsConsent).mockResolvedValue();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("stores the consent with its wording, masked address, and user agent", async () => {
    const response = await submit(form);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(recordSmsConsent).toHaveBeenCalledOnce();
    expect(recordSmsConsent).toHaveBeenCalledWith({
      consentText,
      email: "ada@example.com",
      ipAddress: "198.51.100.0",
      name: "Ada Lovelace",
      pageUrl: "https://responder.example/sms",
      phoneE164: "+14155550123",
      userAgent: "Mozilla/5.0 (Macintosh)",
    });
  });

  it("stores no page address, address, or user agent when none is given", async () => {
    const response = await app.request("/api/sms-consent", {
      body: JSON.stringify(formWithoutPageUrl),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(recordSmsConsent).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: null, pageUrl: null, userAgent: null }),
    );
  });

  it("rejects an invalid submission with a readable message and stores nothing", async () => {
    const response = await submit({ ...form, phone: "020 7946 0958" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Enter a 10-digit US mobile number",
    });
    expect(recordSmsConsent).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a JSON object", async () => {
    for (const body of ["not json", "[]", "null"]) {
      const response = await submit(body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Send the form as a JSON object",
      });
    }
    expect(recordSmsConsent).not.toHaveBeenCalled();
  });

  it("refuses submissions from other sites", async () => {
    const response = await submit(form, { origin: "https://elsewhere.example" });

    expect(response.status).toBe(403);
    expect(recordSmsConsent).not.toHaveBeenCalled();
  });

  it("limits how often one address can submit", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await submit(form)).status).toBe(201);
    }

    const response = await submit(form);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect(recordSmsConsent).toHaveBeenCalledTimes(10);
  });

  it("reports a storage failure without claiming success", async () => {
    vi.mocked(recordSmsConsent).mockRejectedValue(new Error("connection lost"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await submit(form);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Could not save your consent, try again",
    });
  });
});
