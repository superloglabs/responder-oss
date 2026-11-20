import { useEffect } from "react";
import { authClient } from "../auth-client";
import { setBrowserMonitoringIdentity } from "../browser-monitoring";

export function BrowserMonitoringIdentity() {
  const session = authClient.useSession();
  const sessionId = session.data?.session?.id;
  const userName = session.data?.user?.name;
  const userId = session.data?.user?.id;
  const organizationId = session.data?.session?.activeOrganizationId;

  const signedInToOrganization = Boolean(sessionId && userId && organizationId);

  useEffect(() => {
    if (session.isPending || signedInToOrganization) return;
    setBrowserMonitoringIdentity(userId, organizationId, userName, undefined);
  }, [organizationId, session.isPending, signedInToOrganization, userId, userName]);

  // The organization request needs a session, so signed-out visitors skip it.
  if (session.isPending || !sessionId || !userId || !organizationId) return null;
  return (
    <OrganizationIdentity
      organizationId={organizationId}
      sessionId={sessionId}
      userId={userId}
      userName={userName}
    />
  );
}

function OrganizationIdentity({
  organizationId,
  sessionId,
  userId,
  userName,
}: {
  organizationId: string;
  sessionId: string;
  userId: string;
  userName: string | undefined;
}) {
  const organization = authClient.useActiveOrganization();
  const refetchOrganization = organization.refetch;

  useEffect(() => {
    // Sign-in may restore an active organization without invalidating its cache.
    void refetchOrganization().catch(() => undefined);
  }, [organizationId, refetchOrganization, sessionId, userId]);

  const organizationName = organization.data && organization.data.id === organizationId
    ? organization.data.name
    : undefined;

  useEffect(() => {
    setBrowserMonitoringIdentity(userId, organizationId, userName, organizationName);
  }, [organizationId, organizationName, userId, userName]);

  return null;
}
