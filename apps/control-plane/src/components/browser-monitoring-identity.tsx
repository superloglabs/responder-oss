import { useEffect } from "react";
import { authClient } from "../auth-client";
import { setBrowserMonitoringIdentity } from "../browser-monitoring";

export function BrowserMonitoringIdentity() {
  const session = authClient.useSession();
  const organization = authClient.useActiveOrganization();
  const userName = session.data?.user?.name;
  const userId = session.data?.user?.id;
  const organizationId = session.data?.session?.activeOrganizationId;

  const organizationName = organization.data && organization.data.id === organizationId
    ? organization.data.name
    : undefined;

  useEffect(() => {
    if (session.isPending) return;
    setBrowserMonitoringIdentity(userId, organizationId, userName, organizationName);
  }, [organizationId, organizationName, session.isPending, userId, userName]);

  return null;
}
