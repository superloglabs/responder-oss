import { isIP } from "node:net";
import { Hono } from "hono";
import { z } from "zod";
import { recordSmsConsent } from "../../../packages/core/src/db/sms-consents.js";
import { configuredAuthTrustedOrigins } from "./auth.js";
import { createRateLimiter } from "./rate-limit.js";

const maxUserAgentLength = 1_000;

// Each submission stores a row, so one address cannot fill the table.
const submissions = createRateLimiter({ limit: 10, windowMs: 60_000 });

/**
 * Normalizes a US phone number to E.164. Accepts ten digits with the usual
 * punctuation, optionally after 1 or +1, and returns null for anything else.
 */
export function normalizeUsPhoneNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/u.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/gu, "");
  const national =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits.length === 10 && !trimmed.startsWith("+")
        ? digits
        : null;
  // Neither the area code nor the exchange starts with 0 or 1.
  return national && /^[2-9]\d{2}[2-9]\d{6}$/u.test(national)
    ? `+1${national}`
    : null;
}

/**
 * Masks the visitor's address as c15t does for cookie consent: the last
 * octet of an IPv4 address, including one written inside an IPv6 address,
 * or every group after the first three of an IPv6 address becomes zero.
 */
export function maskIpAddress(header: string | undefined): string | null {
  const address = header?.split(",")[0]?.trim();
  if (!address || !isIP(address)) return null;
  if (address.includes(".")) return address.replace(/\.\d+$/u, ".0");

  const [head = "", tail] = address.split("::");
  const groups = head ? head.split(":") : [];
  if (tail !== undefined) {
    const tailGroups = tail ? tail.split(":") : [];
    groups.push(
      ...Array<string>(8 - groups.length - tailGroups.length).fill("0"),
      ...tailGroups,
    );
  }
  const prefix = groups
    .slice(0, 3)
    .map((group) => Number.parseInt(group, 16).toString(16));
  while (prefix.at(-1) === "0") prefix.pop();
  return `${prefix.join(":")}::`;
}

// The form posts from the application's own origin. The cookie consent API
// trusts the same origins through CORS; this refuses other origins outright,
// since a plain-text cross-site POST needs no preflight. Browsers send Origin
// with every POST, so only other clients omit it.
function isTrustedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return configuredAuthTrustedOrigins().some((trusted) => {
    try {
      return new URL(trusted).origin === origin;
    } catch {
      return false;
    }
  });
}

export const smsConsentSchema = z.object(
  {
    name: z
      .string({ error: "Enter your name" })
      .trim()
      .min(1, "Enter your name")
      .max(200, "Use at most 200 characters for your name"),
    email: z
      .string({ error: "Enter your email address" })
      .trim()
      .toLowerCase()
      .pipe(z.email("Enter a valid email address")),
    phone: z
      .string({ error: "Enter your mobile number" })
      .max(40, "Enter a 10-digit US mobile number")
      .transform((value, context) => {
        const phone = normalizeUsPhoneNumber(value);
        if (phone) return phone;
        context.addIssue({
          code: "custom",
          message: "Enter a 10-digit US mobile number",
        });
        return z.NEVER;
      }),
    consent: z.literal(true, {
      error: "Check the box to agree to receive text messages",
    }),
    consentText: z
      .string({ error: "The consent wording is missing" })
      .trim()
      .min(1, "The consent wording is missing")
      .max(2_000, "The consent wording is too long"),
    pageUrl: z
      .string({ error: "The page address must be text" })
      .trim()
      .max(500, "The page address is too long")
      .optional(),
  },
  { error: "Send the form as a JSON object" },
);

export const smsConsentRoutes = new Hono().post("/", async (context) => {
  if (!isTrustedOrigin(context.req.header("origin"))) {
    return context.json({ error: "Untrusted origin" }, 403);
  }

  const clientIp = context.req.header("x-responder-client-ip");
  const limit = submissions.take(clientIp?.split(",")[0]?.trim() || "unknown");
  if (!limit.allowed) {
    // One line per address and window, however many requests are refused.
    if (limit.firstRefusal) {
      console.warn(
        JSON.stringify({
          event: "sms_consent_rate_limited",
          ipAddress: maskIpAddress(clientIp),
        }),
      );
    }
    context.header("retry-after", String(limit.retryAfterSeconds));
    return context.json({ error: "Too many requests, try again in a minute" }, 429);
  }

  const parsed = smsConsentSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid consent" },
      400,
    );
  }

  try {
    await recordSmsConsent({
      consentText: parsed.data.consentText,
      email: parsed.data.email,
      ipAddress: maskIpAddress(clientIp),
      name: parsed.data.name,
      pageUrl: parsed.data.pageUrl || null,
      phoneE164: parsed.data.phone,
      userAgent:
        context.req.header("user-agent")?.slice(0, maxUserAgentLength) || null,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "sms_consent_record_failed",
        errorCode: error instanceof Error ? error.constructor.name : "unknown",
      }),
    );
    return context.json({ error: "Could not save your consent, try again" }, 500);
  }
  return context.json({ ok: true }, 201);
});
