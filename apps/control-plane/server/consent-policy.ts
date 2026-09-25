import { policyPackPresets } from "@c15t/backend";

const europeOptIn = policyPackPresets.europeOptIn();

/**
 * Opt-in consent for the EEA, the United Kingdom, Switzerland, and Quebec;
 * California keeps tracking on by default but honors Global Privacy Control.
 * Other regions show no banner. Visitors whose location is unknown get the
 * European policy.
 */
export const consentPolicyPacks = [
  {
    ...europeOptIn,
    match: {
      ...europeOptIn.match,
      countries: [...(europeOptIn.match.countries ?? []), "CH"],
    },
    consent: {
      ...europeOptIn.consent,
      categories: ["necessary", "measurement", "marketing"],
      scopeMode: "strict" as const,
    },
  },
  policyPackPresets.quebecOptIn(),
  policyPackPresets.californiaOptOut(),
  policyPackPresets.worldNoBanner(),
];

type ConsentPolicy = (typeof consentPolicyPacks)[number];

interface ViewerLocation {
  country: string | null;
  region: string | null;
}

function locationCode(value: string | null): string | null {
  const code = value?.trim();
  return code && /^[A-Za-z0-9]{1,3}$/.test(code) ? code.toUpperCase() : null;
}

/** Reads the visitor's location from the CDN's viewer headers. */
export function viewerLocation(headers: Headers): ViewerLocation {
  return {
    country: locationCode(headers.get("cloudfront-viewer-country")),
    region: locationCode(headers.get("cloudfront-viewer-country-region")),
  };
}

/**
 * c15t resolves the visitor's policy from its own geolocation headers. Derive
 * them from the CDN's viewer headers and drop any a browser sent itself.
 */
export function withViewerLocation(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("x-c15t-country");
  headers.delete("x-c15t-region");
  const { country, region } = viewerLocation(request.headers);
  if (country) headers.set("x-c15t-country", country);
  if (region) headers.set("x-c15t-region", region);
  return new Request(request, { headers });
}

/** Resolves a policy in c15t's order: region, country, unknown location, default. */
export function consentPolicyFor({
  country,
  region,
}: ViewerLocation): ConsentPolicy | undefined {
  const matches = (predicate: (policy: ConsentPolicy) => boolean | undefined) =>
    consentPolicyPacks.find((policy) => predicate(policy));
  if (!country) return matches((policy) => policy.match.fallback);
  return (
    matches((policy) =>
      policy.match.regions?.some(
        (match) => match.country === country && match.region === region,
      ),
    ) ??
    matches((policy) => policy.match.countries?.includes(country)) ??
    matches((policy) => policy.match.isDefault)
  );
}

/**
 * Returns the categories saved in c15t's consent cookie, or null when the
 * visitor has not saved a choice. The cookie lists granted categories as
 * `c.<category>:1` entries.
 */
export function savedConsentCategories(
  cookieHeader: string | null,
): Set<string> | null {
  const cookie = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("c15t="));
  if (!cookie) return null;

  let value: string;
  try {
    value = decodeURIComponent(cookie.slice("c15t=".length));
  } catch {
    return null;
  }
  const categories = new Set<string>();
  for (const entry of value.split(",")) {
    const match = /^c\.([a-z_]+):1$/.exec(entry);
    if (match?.[1]) categories.add(match[1]);
  }
  return categories;
}

/**
 * Whether a request may report advertising conversions: the visitor's saved
 * choice when there is one, otherwise the default of their regional policy.
 */
export function allowsMarketing(headers: Headers): boolean {
  const saved = savedConsentCategories(headers.get("cookie"));
  if (saved) return saved.has("marketing");

  const consent = consentPolicyFor(viewerLocation(headers))?.consent;
  if (!consent || consent.model === "opt-in") return false;
  if ("gpc" in consent && consent.gpc && headers.get("sec-gpc") === "1") {
    return false;
  }
  return true;
}
