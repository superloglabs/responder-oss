import { createHash } from "node:crypto";
import { isIP } from "node:net";

export interface RedditSignupConversion {
  /** Stable deduplication key shared with the browser pixel. */
  conversionId: string;
  email: string;
  /** Reddit click identifier captured from the ad landing URL. */
  clickId?: string;
  ipAddress?: string;
  userAgent?: string;
}

interface RedditConversionConfig {
  accessToken: string;
  eventSourceUrl?: string;
  pixelId: string;
}

let config: RedditConversionConfig | null | undefined;

function configuredEventSourceUrl(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const configuredUrl =
    environment.RESPONDER_PUBLIC_URL ?? environment.BETTER_AUTH_URL;
  if (!configuredUrl) return undefined;
  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function getConfig(): RedditConversionConfig | null {
  if (config !== undefined) return config;

  const accessToken = process.env.REDDIT_ADS_CONVERSION_TOKEN?.trim();
  const pixelId = process.env.REDDIT_ADS_PIXEL_ID?.trim();
  if (!accessToken || !pixelId) {
    config = null;
    return config;
  }
  if (!/^a2_[a-z0-9]+$/i.test(pixelId)) {
    console.error(
      `REDDIT_ADS_PIXEL_ID must look like a2_xxxxx, got "${pixelId}"`,
    );
    config = null;
    return config;
  }
  config = {
    accessToken,
    eventSourceUrl: configuredEventSourceUrl(process.env),
    pixelId,
  };
  return config;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalizeRedditEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1) return null;
  const localPart = normalized
    .slice(0, separator)
    .split("+", 1)[0]
    .replaceAll(".", "");
  const domain = normalized.slice(separator + 1);
  return localPart && domain ? `${localPart}@${domain}` : null;
}

function validClickId(clickId: string | undefined): string | undefined {
  const normalized = clickId?.trim();
  return normalized && /^[A-Za-z0-9_-]{1,255}$/.test(normalized)
    ? normalized
    : undefined;
}

/**
 * Reports a signup to Reddit's Conversions API. Delivery failures are logged
 * without failing account creation. The conversion id is also sent by the
 * browser pixel so Reddit can deduplicate the two copies of the event.
 */
export async function captureRedditSignupConversion(
  input: RedditSignupConversion,
): Promise<void> {
  const configured = getConfig();
  if (!configured) return;

  const canonicalEmail = canonicalizeRedditEmail(input.email);
  if (!canonicalEmail) return;

  const clickId = validClickId(input.clickId);
  const ipAddress = input.ipAddress?.trim();
  const userAgent = input.userAgent?.trim();
  const url = `https://ads-api.reddit.com/api/v3/pixels/${configured.pixelId}/conversion_events`;

  try {
    const response = await fetch(url, {
      body: JSON.stringify({
        data: {
          events: [
            {
              action_source: "WEBSITE",
              ...(clickId ? { click_id: clickId } : {}),
              // Reddit CAPI v3 requires Unix epoch milliseconds.
              event_at: Date.now(),
              ...(configured.eventSourceUrl
                ? { event_source_url: configured.eventSourceUrl }
                : {}),
              metadata: { conversion_id: input.conversionId },
              type: { tracking_type: "SIGN_UP" },
              user: {
                email: sha256(canonicalEmail),
                external_id: sha256(input.conversionId),
                ...(ipAddress && isIP(ipAddress)
                  ? { ip_address: ipAddress }
                  : {}),
                ...(userAgent ? { user_agent: userAgent } : {}),
              },
            },
          ],
        },
      }),
      headers: {
        Authorization: `Bearer ${configured.accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      throw new Error(
        `Reddit Ads API responded with status ${response.status}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Unable to capture Reddit signup conversion: ${message}`);
  }
}
