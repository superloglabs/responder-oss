import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDialogFocusTrap } from "../use-dialog-focus-trap";

const signozConnectUrl = "/api/integrations/signoz/connect";

// Connects a SigNoz Cloud instance with a service account API key. Without
// onConnected, the page follows the returned redirect. The trigger editor sits
// inside the automation form, and forms cannot nest, so the fields are not a
// form of their own.
export function SignozConnectionDialog({
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
  const [instanceUrl, setInstanceUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(dialogRef, open);
  const cancel = useCallback(() => {
    setApiKey("");
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

  const ready = Boolean(instanceUrl.trim() && apiKey.trim());

  async function connect() {
    if (isSubmitting || !ready) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(signozConnectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey, instanceUrl, returnTo }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect SigNoz");
      }
      if (onConnected) {
        setApiKey("");
        setIsSubmitting(false);
        onConnected();
        return;
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to connect SigNoz");
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
        aria-labelledby="signoz-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect SigNoz</span>
          <h2 id="signoz-connection-title">Add your SigNoz Cloud instance</h2>
          <p>
            Responder verifies the key, encrypts it, and uses it only from the
            server to reach SigNoz's MCP server.
          </p>
        </header>

        <div className="siteDialog__form">
          <ol className="siteDialog__instructions">
            <li>In SigNoz, open <strong>Settings → Service Accounts</strong> and create a service account.</li>
            <li>Give it the <strong>Viewer</strong> role to read telemetry, or <strong>Editor</strong> to let runs change alerts and dashboards.</li>
            <li>Create an API key for it and paste it below with your instance URL.</li>
          </ol>
          <label className="siteDialog__field">
            <span>Instance URL</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              maxLength={2_048}
              onChange={(event) => setInstanceUrl(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="https://acme.us.signoz.cloud"
              required
              spellCheck={false}
              type="url"
              value={instanceUrl}
            />
          </label>
          <label className="siteDialog__field">
            <span>API key</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              maxLength={4_096}
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="Paste the service account API key"
              required
              spellCheck={false}
              type="password"
              value={apiKey}
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
              ) : "Connect SigNoz"}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
