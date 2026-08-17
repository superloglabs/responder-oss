import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";

export function UpstashConnectionDialog({
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
  const [email, setEmail] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setEmail("");
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

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(connectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey, email, returnTo }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect Upstash");
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to connect Upstash",
      );
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
        aria-labelledby="upstash-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Upstash</span>
          <h2 id="upstash-connection-title">Add account context</h2>
          <p>
            Responder encrypts these credentials and exposes only read-only
            inventory and investigation tools.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <label className="siteDialog__field">
            <span>Account email</span>
            <input
              autoComplete="email"
              autoFocus
              disabled={isSubmitting}
              maxLength={320}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="operator@example.com"
              required
              type="email"
              value={email}
            />
          </label>
          <p className="siteDialog__oauthNote">
            Upstash requires the account email alongside its developer API key
            for management API authentication.
          </p>
          <label className="siteDialog__field">
            <span>Developer API key</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              maxLength={4_096}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste an Upstash API key"
              required
              spellCheck={false}
              type="password"
              value={apiKey}
            />
          </label>
          <p className="siteDialog__oauthNote">
            Create a dedicated key in Upstash Console → Account → API Keys.
            Responder blocks mutating operations even if the key can write.
          </p>

          {error ? (
            <p className="siteDialog__error" role="alert">
              {error}
            </p>
          ) : null}

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
              disabled={isSubmitting || !email.trim() || !apiKey.trim()}
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <span aria-hidden="true" className="buttonSpinner" />
                  Verifying…
                </>
              ) : (
                "Connect Upstash"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
