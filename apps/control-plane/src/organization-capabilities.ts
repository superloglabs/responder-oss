import { createContext, useContext, useEffect, useState } from "react";
import { authClient } from "./auth-client";

export const OrganizationCapabilitiesContext = createContext<string[] | null>(null);

export async function fetchCapabilities(): Promise<string[]> {
  return (await requestCapabilities()) ?? [];
}

// Returns null when the request fails, so callers can tell a failure from a
// workspace without capabilities.
export async function requestCapabilities(): Promise<string[] | null> {
  const response = await fetch("/api/context").catch(() => null);
  if (!response?.ok) return null;
  const context = await (response.json() as Promise<{ capabilities?: string[] }>)
    .catch(() => null);
  return context ? context.capabilities ?? [] : null;
}

// Pages outside the provider, such as public templates, fetch their own copy.
// Until that request finishes, and for signed-out visitors, no capability is
// enabled.
export function useOrganizationCapabilities(signedIn = true): string[] {
  const provided = useContext(OrganizationCapabilitiesContext);
  const session = authClient.useSession();
  const activeOrganizationId = session.data?.session.activeOrganizationId;
  const [fetched, setFetched] = useState<string[]>([]);
  const shouldFetch = signedIn && provided === null;

  useEffect(() => {
    if (!shouldFetch) return;
    let cancelled = false;
    void fetchCapabilities().then((capabilities) => {
      if (!cancelled) setFetched(capabilities);
    });
    return () => { cancelled = true; };
  }, [shouldFetch, activeOrganizationId]);

  if (!signedIn) return [];
  return provided ?? fetched;
}
