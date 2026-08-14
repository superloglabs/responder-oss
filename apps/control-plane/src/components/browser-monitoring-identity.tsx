import { useEffect } from "react";
import { authClient } from "../auth-client";
import { setBrowserMonitoringIdentity } from "../browser-monitoring";

export function BrowserMonitoringIdentity() {
  const session = authClient.useSession();
  const userId = session.data?.user?.id;
  const organizationId = session.data?.session?.activeOrganizationId;

  useEffect(() => {
    if (session.isPending) return;
    setBrowserMonitoringIdentity(userId, organizationId);
  }, [organizationId, session.isPending, userId]);

  return null;
}
