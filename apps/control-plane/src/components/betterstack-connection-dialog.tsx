import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDialogFocusTrap } from "../use-dialog-focus-trap";

const betterStackConnectUrl = "/api/integrations/betterstack/connect";

// Connects a Better Stack organization with a global API token. Without
// onConnected, the page follows the returned redirect. The trigger editor sits
// inside the automation form, and forms cannot nest, so the field is not a
// form of its own.
export function BetterStackConnectionDialog({
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
  const [apiToken, setApiToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(dialogRef, open);
  const cancel = useCallback(() => {
    setApiToken("");
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

  const ready = Boolean(apiToken.trim());

  async function connect() {
    if (isSubmitting || !ready) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(betterStackConnectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiToken, returnTo }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect Better Stack");
      }
      if (onConnected) {
        setApiToken("");
        setIsSubmitting(false);
        onConnected();
        return;
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to connect Better Stack");
      setIsSubmitting(false);
    }
  }

  if (!open) return null;

  const submitOnEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void connect();
  };

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) cancel();
      }}
    >
      <section
        ref={dialogRef}
        aria-labelledby="betterstack-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Better Stack</span>
          <h2 id="betterstack-connection-title">Add a Better Stack API token</h2>
          <p>
            Responder verifies the token, encrypts it, and uses it only from the
            server to reach Better Stack's MCP server.
          </p>
        </header>

        <div className="siteDialog__form">
          <ol className="siteDialog__instructions">
            <li>
              In Better Stack, open{" "}
              <a href="https://betterstack.com/settings/global-api-tokens" rel="noreferrer" target="_blank">API tokens</a>{" "}
              and create a token under <strong>Global API tokens</strong>.
            </li>
            <li>Read-only access is enough for investigations.</li>
            <li>Paste the token below.</li>
          </ol>
          <label className="siteDialog__field">
            <span>API token</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              maxLength={4_096}
              onChange={(event) => setApiToken(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="Paste the global API token"
              required
              spellCheck={false}
              type="password"
              value={apiToken}
            />
          </label>

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
              disabled={isSubmitting || !ready}
              onClick={() => void connect()}
              type="button"
            >
              {isSubmitting ? (
                <><span aria-hidden="true" className="buttonSpinner" />Verifying…</>
              ) : "Connect Better Stack"}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
