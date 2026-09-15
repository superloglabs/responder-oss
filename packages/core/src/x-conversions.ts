import { createHash, createHmac, randomBytes } from "node:crypto";

export interface XSignupConversion {
  /** Stable deduplication key for the conversion, normally the user id. */
  conversionId: string;
  email?: string;
  /** X click identifier captured from the ad landing URL. */
  twclid?: string;
}

interface XConversionConfigBase {
  eventId: string;
  pixelId: string;
}

interface XOAuthConversionConfig extends XConversionConfigBase {
  authentication: "oauth";
  accessToken: string;
  accessTokenSecret: string;
  consumerKey: string;
  consumerSecret: string;
}

interface XPixelTokenConversionConfig extends XConversionConfigBase {
  authentication: "pixel-token";
  pixelToken: string;
}

type XConversionConfig =
  | XOAuthConversionConfig
  | XPixelTokenConversionConfig;

let configs: XConversionConfig[] | undefined;

function eventConfig(
  eventId: string,
  environmentName: string,
): XConversionConfigBase | null {
  // Event ids look like tw-pixel1-event1; the middle segment is the pixel id
  // that addresses the Conversion API endpoint.
  const pixelId = /^tw-([a-z0-9]+)-[a-z0-9]+$/i.exec(eventId)?.[1];
  if (!pixelId) {
    console.error(
      `${environmentName} must look like tw-xxxxx-yyyyy, got "${eventId}"`,
    );
    return null;
  }
  return { eventId, pixelId };
}

function getConfigs(): XConversionConfig[] {
  if (configs !== undefined) return configs;

  configs = [];

  const consumerKey = process.env.X_ADS_CONSUMER_KEY;
  const consumerSecret = process.env.X_ADS_CONSUMER_SECRET;
  const accessToken = process.env.X_ADS_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ADS_ACCESS_TOKEN_SECRET;
  const eventId = process.env.X_ADS_SIGNUP_EVENT_ID;
  if (
    consumerKey &&
    consumerSecret &&
    accessToken &&
    accessTokenSecret &&
    eventId
  ) {
    const event = eventConfig(eventId, "X_ADS_SIGNUP_EVENT_ID");
    if (event) {
      configs.push({
        ...event,
        accessToken,
        accessTokenSecret,
        authentication: "oauth",
        consumerKey,
        consumerSecret,
      });
    }
  }

  const pixelToken = process.env.X_ADS_PIXEL_TOKEN;
  const pixelTokenEventId = process.env.X_ADS_PIXEL_TOKEN_SIGNUP_EVENT_ID;
  if (pixelToken && pixelTokenEventId) {
    const event = eventConfig(
      pixelTokenEventId,
      "X_ADS_PIXEL_TOKEN_SIGNUP_EVENT_ID",
    );
    if (event) {
      configs.push({
        ...event,
        authentication: "pixel-token",
        pixelToken,
      });
    }
  }

  return configs;
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// The Conversion API authenticates with OAuth 1.0a user context. JSON bodies
// are excluded from the signature, so the base string only covers the
// oauth_* parameters.
function buildOAuthHeader(
  credentials: XOAuthConversionConfig,
  method: string,
  url: string,
): string {
  const parameters: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };
  const parameterString = Object.keys(parameters)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(parameters[key])}`)
    .join("&");
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(parameterString),
  ].join("&");
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.accessTokenSecret)}`;
  parameters.oauth_signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
  const header = Object.keys(parameters)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(parameters[key])}"`)
    .join(", ");
  return `OAuth ${header}`;
}

/**
 * Reports a signup conversion to the X Ads Conversion API without allowing
 * delivery errors to fail the signup. Sending server side keeps the
 * conversion out of reach of content blockers; X matches it through the
 * hashed email and, when the visitor arrived through an ad click, the twclid.
 */
export async function captureXSignupConversion(
  input: XSignupConversion,
): Promise<void> {
  const configuredTrackers = getConfigs();
  if (configuredTrackers.length === 0) return;

  const identifiers: Record<string, string>[] = [];
  const email = input.email?.trim().toLowerCase();
  if (email) {
    identifiers.push({
      hashed_email: createHash("sha256").update(email).digest("hex"),
    });
  }
  if (input.twclid) {
    identifiers.push({ twclid: input.twclid });
  }
  if (identifiers.length === 0) return;

  const conversionTime = new Date().toISOString();
  await Promise.all(
    configuredTrackers.map(async (tracker) => {
      const url = `https://ads-api.x.com/12/measurement/conversions/${tracker.pixelId}`;
      try {
        const response = await fetch(url, {
          body: JSON.stringify({
            conversions: [
              {
                conversion_id: input.conversionId,
                conversion_time: conversionTime,
                event_id: tracker.eventId,
                identifiers,
              },
            ],
          }),
          headers: {
            ...(tracker.authentication === "oauth"
              ? { Authorization: buildOAuthHeader(tracker, "POST", url) }
              : { "X-Pixel-Token": tracker.pixelToken }),
            "Content-Type": "application/json",
          },
          method: "POST",
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
          throw new Error(`X Ads API responded with status ${response.status}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Unable to capture X signup conversion: ${message}`);
      }
    }),
  );
}
