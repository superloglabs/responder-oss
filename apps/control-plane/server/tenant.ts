import * as Sentry from "@sentry/hono/node";
import { getOrganizationMembership } from "@responder/core/db/organizations";
import { getAuth } from "./auth.js";

export type ActiveTenantResult =
  | {
      ok: true;
      organizationId: string;
      role: string;
      user: {
        email: string;
        id: string;
        name: string;
      };
    }
  | {
      ok: false;
      error: string;
      status: 401 | 403 | 409;
    };

export async function getActiveTenant(headers: Headers): Promise<ActiveTenantResult> {
  const auth = getAuth();
  const authSession = await auth.api.getSession({ headers });
  if (!authSession) {
    return { ok: false, error: "Unauthorized", status: 401 };
  }

  Sentry.setUser({ id: authSession.user.id, username: authSession.user.name });

  const organizationId = authSession.session.activeOrganizationId;
  if (!organizationId) {
    return { ok: false, error: "No active organization", status: 409 };
  }

  // A session can outlive its workspace or membership. Read that expected
  // absence directly: the auth endpoint records an exception before throwing.
  const activeMember = await getOrganizationMembership(authSession.user.id, organizationId);
  if (
    !activeMember ||
    activeMember.organizationId !== organizationId ||
    activeMember.userId !== authSession.user.id
  ) {
    return { ok: false, error: "Organization access denied", status: 403 };
  }

  Sentry.setTag("organization_id", organizationId);

  return {
    ok: true,
    organizationId,
    role: activeMember.role,
    user: {
      email: authSession.user.email,
      id: authSession.user.id,
      name: authSession.user.name,
    },
  };
}
