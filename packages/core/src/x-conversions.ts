import { createHash, createHmac, randomBytes } from "node:crypto";

export interface XSignupConversion {
  /** Stable deduplication key for the conversion, normally the user id. */
  conversionId: string;
  email?: string;
  /** X click identifier captured from the ad landing URL. */
  twclid?: string;
}

interface XConversionConfig {
  accessToken: string;
  accessTokenSecret: string;
  consumerKey: string;
  consumerSecret: string;
  eventId: string;
  pixelId: string;
}

let config: XConversionConfig | null | undefined;

function getConfig(): XConversionConfig | null {
  if (config !== undefined) return config;

  const consumerKey = process.env.X_ADS_CONSUMER_KEY;
  const consumerSecret = process.env.X_ADS_CONSUMER_SECRET;
  const accessToken = process.env.X_ADS_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ADS_ACCESS_TOKEN_SECRET;
  const eventId = process.env.X_ADS_SIGNUP_EVENT_ID;
  if (
    !consumerKey ||
    !consumerSecret ||
    !accessToken ||
    !accessTokenSecret ||
    !eventId
  ) {
    config = null;
    return config;
  }

  // Event ids look like tw-pixel1-event1; the middle segment is the pixel id
  // that addresses the Conversion API endpoint.
  const pixelId = /^tw-([a-z0-9]+)-[a-z0-9]+$/i.exec(eventId)?.[1];
  if (!pixelId) {
    console.error(
      `X_ADS_SIGNUP_EVENT_ID must look like tw-xxxxx-yyyyy, got "${eventId}"`,
    );
    config = null;
    return config;
  }

  config = {
    accessToken,
    accessTokenSecret,
    consumerKey,
    consumerSecret,
    eventId,
    pixelId,
  };
  return config;
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
  credentials: XConversionConfig,
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
  const credentials = getConfig();
  if (!credentials) return;

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

  const url = `https://ads-api.x.com/12/measurement/conversions/${credentials.pixelId}`;
  try {
    const response = await fetch(url, {
      body: JSON.stringify({
        conversions: [
          {
            conversion_id: input.conversionId,
            conversion_time: new Date().toISOString(),
            event_id: credentials.eventId,
            identifiers,
          },
        ],
      }),
      headers: {
        Authorization: buildOAuthHeader(credentials, "POST", url),
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
}
