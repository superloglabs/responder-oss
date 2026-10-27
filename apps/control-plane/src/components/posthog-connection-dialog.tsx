import { useCallback, useEffect, useState, type FormEvent } from "react";

type PostHogAccessLevel = "read_only" | "read_write";

const ACCESS_LEVELS: Array<{
  description: string;
  label: string;
  value: PostHogAccessLevel;
}> = [
  {
    description: "Insights, dashboards, events, logs, errors, and replays. Nothing can be changed.",
    label: "Read only",
    value: "read_only",
  },
  {
    description:
      "Everything in read only. Automations can also create and change insights, dashboards, alerts, feature flags, annotations, cohorts, experiments, notebooks, and surveys. Investigations, tag mode, and scans still only read.",
    label: "Read and write",
    value: "read_write",
  },
];

/** The URL that starts PostHog OAuth at the chosen access level. */
function postHogConnectionUrl(
  connectUrl: string,
  accessLevel: PostHogAccessLevel,
  returnTo: string,
): string {
  const url = new URL(connectUrl, window.location.origin);
  url.searchParams.set("returnTo", returnTo);
  if (accessLevel === "read_write") url.searchParams.set("mode", "read_write");
  return `${url.pathname}${url.search}`;
}

export function PostHogConnectionDialog({
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
  const [accessLevel, setAccessLevel] = useState<PostHogAccessLevel>("read_only");
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
    window.location.assign(postHogConnectionUrl(connectUrl, accessLevel, returnTo));
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
        aria-labelledby="posthog-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect PostHog</span>
          <h2 id="posthog-connection-title">Choose PostHog access</h2>
          <p>Choose what agents may do with this PostHog connection.</p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <label className="siteDialog__field">
            <span>Agent access</span>
            <select
              autoFocus
              disabled={isSubmitting}
              onChange={(event) => setAccessLevel(event.target.value as PostHogAccessLevel)}
              value={accessLevel}
            >
              {ACCESS_LEVELS.map((level) => (
                <option key={level.value} value={level.value}>{level.label}</option>
              ))}
            </select>
          </label>
          <p className="siteDialog__oauthNote">{selected.description}</p>
          {accessLevel === "read_write" ? (
            <p className="siteDialog__error" role="note">
              Feature flag and experiment changes affect your users.
            </p>
          ) : null}
          <p className="siteDialog__oauthNote">
            You’ll continue to PostHog to approve access.
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
                "Continue with PostHog"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
