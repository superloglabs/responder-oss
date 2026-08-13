import { useEffect, useRef } from "react";
import { authClient } from "../auth-client";
import { identifyBrowserUser } from "../browser-analytics";

export function BrowserAnalyticsIdentity() {
  const session = authClient.useSession();
  const lastIdentity = useRef<string | null>(null);

  const userId = session.data?.user.id;
  const userEmail = session.data?.user.email;
  const userName = session.data?.user.name;
  const organizationId = session.data?.session.activeOrganizationId;

  useEffect(() => {
    if (session.isPending || !userId) return;

    const identity = `${userId}:${organizationId ?? ""}`;
    if (lastIdentity.current === identity) return;

    void identifyBrowserUser(
      {
        id: userId,
        email: userEmail,
        name: userName,
      },
      organizationId,
    );
    lastIdentity.current = identity;
  }, [organizationId, session.isPending, userEmail, userId, userName]);

  return null;
}
