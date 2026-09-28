import { type ReactNode, useEffect, useState } from "react";
import { authClient } from "../auth-client";
import {
  fetchCapabilities,
  OrganizationCapabilitiesContext,
} from "../organization-capabilities";

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
