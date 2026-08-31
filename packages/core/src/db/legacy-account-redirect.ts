import { eq } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { legacyAccountRedirect } from "./schema.js";

const DEFAULT_LEGACY_PRODUCT_URL = "https://telemetry.superlog.sh";

/** Normalize only the value used for an exact account lookup. */
export function normalizeLegacyEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Return the configured legacy product origin. This is deliberately not an
 * arbitrary URL from a request, so the redirect endpoint cannot become an
 * open redirector.
 */
export function legacyProductUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.LEGACY_PRODUCT_URL ?? DEFAULT_LEGACY_PRODUCT_URL;
  const url = new URL(configured);
  if (
    (url.protocol !== "https:" && url.hostname !== "localhost") ||
    (url.hostname !== "telemetry.superlog.sh" && url.hostname !== "localhost")
  ) {
    throw new Error("LEGACY_PRODUCT_URL must be telemetry.superlog.sh over HTTPS");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function shouldRedirectLegacyAccount(email: string): Promise<boolean> {
  const marker = await getDatabase().query.legacyAccountRedirect.findFirst({
    where: eq(
      legacyAccountRedirect.emailNormalized,
      normalizeLegacyEmail(email),
    ),
    columns: { redirectEnabled: true },
  });
  return marker?.redirectEnabled === true;
}

/** Keep the row for auditability and to make an explicit migration sticky. */
export async function clearLegacyAccountRedirect(email: string): Promise<void> {
  await getDatabase()
    .update(legacyAccountRedirect)
    .set({ redirectEnabled: false })
    .where(
      eq(
        legacyAccountRedirect.emailNormalized,
        normalizeLegacyEmail(email),
      ),
    );
}
