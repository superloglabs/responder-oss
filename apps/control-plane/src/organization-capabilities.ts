import { useEffect, useState } from "react";
import { authClient } from "./auth-client";

// Reads the active organization's enabled capabilities. Until the request
// finishes, and for signed-out visitors, no capability is enabled.
export function useOrganizationCapabilities(signedIn = true): string[] {
  const session = authClient.useSession();
  const activeOrganizationId = session.data?.session.activeOrganizationId;
  const [capabilities, setCapabilities] = useState<string[]>([]);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void fetch("/api/context")
      .then(async (response) => response.ok
        ? response.json() as Promise<{ capabilities?: string[] }>
        : null)
      .then((context) => {
        if (!cancelled) setCapabilities(context?.capabilities ?? []);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [signedIn, activeOrganizationId]);

  return capabilities;
}
