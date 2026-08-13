import { getAuth } from "./auth.js";

export type ActiveTenantResult =
  | {
      ok: true;
      organizationId: string;
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

  return {
    ok: true,
    organizationId,
    user: {
      email: authSession.user.email,
      id: authSession.user.id,
      name: authSession.user.name,
    },
  };
}
