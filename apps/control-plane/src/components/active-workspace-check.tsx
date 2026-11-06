import { type ReactNode, useEffect, useRef, useState } from "react";
import { authClient } from "../auth-client";
import { authErrorCode } from "../auth-error-code";

// A session can keep naming a workspace after the workspace is deleted or the
// person is removed from it, and every page then fails with "Organization
// access denied". When the person's workspace list leaves out the active
// workspace, this asks Better Auth to activate it again. Better Auth clears the
// active workspace of a non-member and answers 403, so the session reloads and
// setup can find the person's workspaces here or in another region. A member
// whose list was only out of date is activated again and sees no change.
export function ActiveWorkspaceCheck({
  activeOrganizationId,
  children,
  fallback,
  onCleared,
}: {
  activeOrganizationId: string;
  children: ReactNode;
  fallback: ReactNode;
  onCleared: () => Promise<unknown>;
}) {
  const organizations = authClient.useListOrganizations();
  const [checked, setChecked] = useState<string | null>(null);
  const inFlight = useRef<string | null>(null);
  const listed = organizations.data;
  const missing =
    !organizations.isPending &&
    !organizations.isRefetching &&
    !organizations.error &&
    Array.isArray(listed) &&
    !listed.some((organization) => organization.id === activeOrganizationId);
  const checking = missing && checked !== activeOrganizationId;

  useEffect(() => {
    if (!checking || inFlight.current === activeOrganizationId) return;
    inFlight.current = activeOrganizationId;
    void authClient.organization
      .setActive({ organizationId: activeOrganizationId })
      .then(async (result) => {
        if (result.error?.status === 403) {
          console.warn(
            JSON.stringify({
              event: "stale_active_workspace_cleared",
              organizationId: activeOrganizationId,
            }),
          );
          await onCleared();
        } else if (result.error) {
          console.error(
            JSON.stringify({
              event: "stale_active_workspace_check_failed",
              organizationId: activeOrganizationId,
              errorCode: authErrorCode(result.error),
            }),
          );
        }
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "stale_active_workspace_check_failed",
            organizationId: activeOrganizationId,
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(() => {
        inFlight.current = null;
        setChecked(activeOrganizationId);
      });
  }, [activeOrganizationId, checking, onCleared]);

  return checking ? fallback : children;
}
