import { useState } from "react";
import { authErrorCode } from "../auth-error-code";
import { authClient } from "../auth-client";

export function ImpersonationBanner() {
  const session = authClient.useSession();
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session.data?.session.impersonatedBy) return null;

  async function stopImpersonating() {
    setError(null);
    setIsStopping(true);
    const result = await authClient.admin.stopImpersonating();
    setIsStopping(false);
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "impersonation_stop_failed",
          errorCode: authErrorCode(result.error),
          actorUserId: session.data?.session.impersonatedBy ?? null,
          targetUserId: session.data?.user.id ?? null,
        }),
      );
      setError("Could not return to your account. Please try again.");
      return;
    }
    window.location.assign("/superuser/users");
  }

  return (
    <aside className="impersonationBanner" role="status">
      <div>
        <strong>Viewing Responder as {session.data.user.name}</strong>
        <span>{session.data.user.email}</span>
      </div>
      {error ? <span className="impersonationBanner__error">{error}</span> : null}
      <button
        disabled={isStopping}
        onClick={() => void stopImpersonating()}
        type="button"
      >
        {isStopping ? "Returning…" : "Return to superuser account"}
      </button>
    </aside>
  );
}
