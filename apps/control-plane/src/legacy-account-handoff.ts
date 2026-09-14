export const explicitSignupStorageKey = "superlog_explicit_signup";

interface LegacyAccountHandoffConfig {
  signInUrl: string;
  targetUrl: string;
}

interface LegacySessionRoutingInput {
  explicitSignup: boolean;
  newSocialUser: boolean;
}

function configuredOrigin(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.hostname !== "localhost") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function configuredCookieDomain(value: string | undefined): string | null {
  const domain = value?.trim().toLowerCase().replace(/^\./, "");
  if (!domain || domain.includes(":")) return null;
  if (domain === "localhost") return domain;
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
    domain,
  )
    ? domain
    : null;
}

function usesCookieDomain(origin: URL, cookieDomain: string): boolean {
  const hostname = origin.hostname.toLowerCase();
  return hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`);
}

export function legacyAccountHandoffConfig(
  environment: ImportMetaEnv = import.meta.env,
): LegacyAccountHandoffConfig | null {
  const authOrigin = configuredOrigin(environment.VITE_LEGACY_AUTH_ORIGIN);
  const productOrigin = configuredOrigin(environment.VITE_LEGACY_PRODUCT_ORIGIN);
  const cookieDomain = configuredCookieDomain(
    environment.VITE_LEGACY_COOKIE_DOMAIN,
  );
  if (
    !authOrigin ||
    !productOrigin ||
    !cookieDomain ||
    !usesCookieDomain(authOrigin, cookieDomain) ||
    !usesCookieDomain(productOrigin, cookieDomain)
  ) {
    return null;
  }

  return {
    signInUrl: new URL("/api/auth/sign-in/email", authOrigin).toString(),
    targetUrl: productOrigin.toString(),
  };
}

export async function tryLegacyEmailSignIn(
  email: string,
  password: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<string | null> {
  const handoff = legacyAccountHandoffConfig();
  if (!handoff) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(handoff.signInUrl, {
      body: JSON.stringify({ email, password }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    return response.ok ? handoff.targetUrl : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function explicitSignupIntent(
  storedIntent: string | null,
  returnedSocialIntent: string | null,
): boolean {
  if (storedIntent === "email") return true;
  return Boolean(
    returnedSocialIntent && storedIntent === `social:${returnedSocialIntent}`,
  );
}

export function legacySessionRoutingIntent({
  explicitSignup,
  newSocialUser,
}: LegacySessionRoutingInput) {
  return {
    clearMarker: explicitSignup,
    lookupMarker: !explicitSignup,
    trackSocialSignup: newSocialUser,
  };
}
