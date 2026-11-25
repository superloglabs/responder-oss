import * as Sentry from "@sentry/hono/node";
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

export type ActiveTenantSessionResult =
  | Extract<ActiveTenantResult, { ok: false }>
  | (Extract<ActiveTenantResult, { ok: true }> & { sessionId: string });

export async function getActiveTenant(headers: Headers): Promise<ActiveTenantResult> {
  const result = await getActiveTenantSession(headers);
  if (result.ok === false) return result;
  return {
    ok: true,
    organizationId: result.organizationId,
    role: result.role,
    user: result.user,
  };
}

// The active tenant and the session that reached it, for writes that must
// not outlive that session.
export async function getActiveTenantSession(
  headers: Headers,
): Promise<ActiveTenantSessionResult> {
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

  const activeMember = await auth.api
    .getActiveMember({ headers })
    .catch(() => null);
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
    sessionId: authSession.session.id,
    user: {
      email: authSession.user.email,
      id: authSession.user.id,
      name: authSession.user.name,
    },
  };
}
