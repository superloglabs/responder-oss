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

export function legacyAccountHandoffConfig(
  environment: ImportMetaEnv = import.meta.env,
): LegacyAccountHandoffConfig | null {
  const authOrigin = configuredOrigin(environment.VITE_LEGACY_AUTH_ORIGIN);
  const productOrigin = configuredOrigin(environment.VITE_LEGACY_PRODUCT_ORIGIN);
  if (!authOrigin || !productOrigin) return null;

  return {
    signInUrl: new URL("/api/auth/sign-in/email", authOrigin).toString(),
    targetUrl: productOrigin.toString(),
  };
}

export async function tryLegacyEmailSignIn(
  email: string,
  password: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const handoff = legacyAccountHandoffConfig();
  if (!handoff) return null;

  try {
    const response = await fetcher(handoff.signInUrl, {
      body: JSON.stringify({ email, password }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return response.ok ? handoff.targetUrl : null;
  } catch {
    return null;
  }
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
