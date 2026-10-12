import { useCallback, useEffect, useState } from "react";

const devrevConnectUrl = "/api/integrations/devrev/connect";

// Connects DevRev with a personal access token. Responder registers the
// new-ticket webhook with it. Without onConnected, the page follows the
// returned redirect. The trigger editor sits inside the automation form, and
// forms cannot nest, so the fields are not a form of their own.
export function DevRevConnectionDialog({
  open,
  onCancel,
  onConnected,
  returnTo,
}: {
  open: boolean;
  onCancel: () => void;
  onConnected?: () => void;
  returnTo: string;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setToken("");
    setError(null);
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

  async function connect() {
    if (isSubmitting || !token.trim()) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(devrevConnectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnTo, token }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect DevRev");
      }
      if (onConnected) {
        setToken("");
        setIsSubmitting(false);
        onConnected();
        return;
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to connect DevRev");
      setIsSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) cancel();
      }}
    >
      <section
        aria-labelledby="devrev-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect DevRev</span>
          <h2 id="devrev-connection-title">Run automations on new tickets</h2>
          <p>
            Responder encrypts the token, registers a webhook for new tickets,
            and posts each run's result as an internal comment on its ticket.
          </p>
        </header>

        <div className="siteDialog__form">
          <ol className="siteDialog__instructions">
            <li>Sign in to DevRev as an admin of the organization.</li>
            <li>Open <strong>Settings → Account → Personal access token</strong>.</li>
            <li>Create a token and paste it below.</li>
          </ol>
          <label className="siteDialog__field">
            <span>Personal access token</span>
            <input
              autoComplete="off"
              autoFocus
              disabled={isSubmitting}
              maxLength={4_096}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void connect();
              }}
              required
              spellCheck={false}
              type="password"
              value={token}
            />
          </label>
          <p className="siteDialog__oauthNote">
            Comments are posted as the person who created the token.
          </p>

          {error ? <p className="siteDialog__error" role="alert">{error}</p> : null}

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
              disabled={isSubmitting || !token.trim()}
              onClick={() => void connect()}
              type="button"
            >
              {isSubmitting ? (
                <><span aria-hidden="true" className="buttonSpinner" />Verifying…</>
              ) : "Connect DevRev"}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
