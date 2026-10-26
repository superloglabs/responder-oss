import { getDatabase } from "./client.js";
import { smsConsents } from "./schema.js";

export interface SmsConsentRecord {
  consentText: string;
  email: string;
  ipAddress: string | null;
  name: string;
  pageUrl: string | null;
  phoneE164: string;
  userAgent: string | null;
}

/** Stores one SMS opt-in. Each submission is a new row; none is updated. */
export async function recordSmsConsent(record: SmsConsentRecord): Promise<void> {
  await getDatabase().insert(smsConsents).values(record);
}
