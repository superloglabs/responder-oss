import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import { smsConsents } from "./schema.js";
import { recordSmsConsent } from "./sms-consents.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

describe("SMS consents", () => {
  beforeEach(() => vi.mocked(getDatabase).mockReset());

  it("inserts one row per consent with the wording that was agreed to", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values }));
    vi.mocked(getDatabase).mockReturnValue({
      insert,
    } as unknown as ReturnType<typeof getDatabase>);
    const record = {
      consentText: "I agree to receive text messages from Superlog.",
      email: "ada@example.com",
      ipAddress: "198.51.100.0",
      name: "Ada Lovelace",
      pageUrl: "https://responder.example/sms",
      phoneE164: "+14155550123",
      userAgent: "Mozilla/5.0",
    };

    await recordSmsConsent(record);

    expect(insert).toHaveBeenCalledWith(smsConsents);
    expect(values).toHaveBeenCalledWith(record);
  });

  it("requires the consent wording on every row", () => {
    const migration = readFileSync(
      new URL("../../../../drizzle/0098_sms_consents.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('"consent_text" text NOT NULL');
    expect(migration).toContain('"phone_e164" text NOT NULL');
    expect(migration).toContain('CREATE INDEX "sms_consents_phone_idx"');
  });
});
