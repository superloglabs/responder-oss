import { useCallback, useEffect, useState, type FormEvent } from "react";

type RailwayAccessLevel = "read_only" | "redeploy";

const ACCESS_LEVELS: Array<{
  description: string;
  label: string;
  value: RailwayAccessLevel;
}> = [
  {
    description: "Projects, deployments, logs, and metrics. Nothing can be changed.",
    label: "Read only",
    value: "read_only",
  },
  {
    description:
      "Everything in read only. Tag mode and automations can also redeploy and restart deployments when asked. Alert investigations and scans still only read.",
    label: "Read and redeploy",
    value: "redeploy",
  },
];

/** The URL that starts Railway OAuth at the chosen access level. */
function railwayConnectionUrl(
  connectUrl: string,
  accessLevel: RailwayAccessLevel,
  returnTo: string,
): string {
  const url = new URL(connectUrl, window.location.origin);
  url.searchParams.set("returnTo", returnTo);
  if (accessLevel === "redeploy") url.searchParams.set("mode", "redeploy");
  return `${url.pathname}${url.search}`;
}

export function RailwayConnectionDialog({
  connectUrl,
  open,
  onCancel,
  returnTo,
}: {
  connectUrl: string;
  open: boolean;
  onCancel: () => void;
  returnTo: string;
}) {
  const [accessLevel, setAccessLevel] = useState<RailwayAccessLevel>("read_only");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setAccessLevel("read_only");
    setIsSubmitting(false);
    onCancel();
  }, [onCancel]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) cancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cancel, isSubmitting, open]);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || !connectUrl) return;
    setIsSubmitting(true);
    window.location.assign(railwayConnectionUrl(connectUrl, accessLevel, returnTo));
  }

  if (!open) return null;

  const selected = ACCESS_LEVELS.find((level) => level.value === accessLevel)!;

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) cancel();
      }}
    >
      <section
        aria-labelledby="railway-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Railway</span>
          <h2 id="railway-connection-title">Choose Railway access</h2>
          <p>Choose what agents may do with this Railway connection.</p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <label className="siteDialog__field">
            <span>Agent access</span>
            <select
              autoFocus
              disabled={isSubmitting}
              onChange={(event) => setAccessLevel(event.target.value as RailwayAccessLevel)}
              value={accessLevel}
            >
              {ACCESS_LEVELS.map((level) => (
                <option key={level.value} value={level.value}>{level.label}</option>
              ))}
            </select>
          </label>
          <p className="siteDialog__oauthNote">{selected.description}</p>
          {accessLevel === "redeploy" ? (
            <p className="siteDialog__error" role="note">
              Redeploys and restarts change production services.
            </p>
          ) : null}
          <p className="siteDialog__oauthNote">
            You’ll continue to Railway and choose the workspaces to share.
          </p>

          <footer className="siteDialog__footer">
            <button
              className="button button--secondary button--small"
              disabled={isSubmitting}
              onClick={cancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="button button--primary button--small"
              disabled={isSubmitting || !connectUrl}
              type="submit"
            >
              {isSubmitting ? (
                <><span aria-hidden="true" className="buttonSpinner" />Connecting…</>
              ) : (
                "Continue with Railway"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
