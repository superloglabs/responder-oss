import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { authClient } from "./auth-client";

const OrganizationCapabilitiesContext = createContext<string[] | null>(null);

async function fetchCapabilities(): Promise<string[]> {
  const response = await fetch("/api/context").catch(() => null);
  if (!response?.ok) return [];
  const context = await (response.json() as Promise<{ capabilities?: string[] }>)
    .catch(() => null);
  return context?.capabilities ?? [];
}

// Loads the active organization's capabilities once for every page below it.
// Pages render after the capabilities arrive, so navigation does not switch
// layouts after the first paint.
export function OrganizationCapabilitiesProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const session = authClient.useSession();
  const organizationId = session.data?.session.activeOrganizationId ?? null;
  const [loaded, setLoaded] = useState<{
    capabilities: string[];
    organizationId: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCapabilities().then((capabilities) => {
      if (!cancelled) setLoaded({ capabilities, organizationId });
    });
    return () => { cancelled = true; };
  }, [organizationId]);

  if (loaded?.organizationId !== organizationId) return fallback;
  return (
    <OrganizationCapabilitiesContext.Provider value={loaded.capabilities}>
      {children}
    </OrganizationCapabilitiesContext.Provider>
  );
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
