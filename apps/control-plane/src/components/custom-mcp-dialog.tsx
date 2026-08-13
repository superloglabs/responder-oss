import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";

type AuthType = "api_token" | "oauth";

export function CustomMcpConnectionDialog({
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
  const [displayName, setDisplayName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [authType, setAuthType] = useState<AuthType>("api_token");
  const [apiToken, setApiToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setDisplayName("");
    setMcpUrl("");
    setAuthType("api_token");
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

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(connectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(authType === "api_token" ? { apiToken } : {}),
          authType,
          displayName,
          mcpUrl,
          returnTo,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect the MCP server");
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to connect the MCP server",
      );
      setIsSubmitting(false);
    }
  }

  if (!open) return null;

  const complete =
    displayName.trim() &&
    mcpUrl.trim() &&
    (authType === "oauth" || apiToken.trim());

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) cancel();
      }}
    >
      <section
        aria-labelledby="custom-mcp-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect MCP</span>
          <h2 id="custom-mcp-connection-title">Add a remote MCP server</h2>
          <p>
            Responder checks the server, encrypts its credentials, and exposes
            its tools only to agents you select.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <label className="siteDialog__field">
            <span>Name</span>
            <input
              autoFocus
              disabled={isSubmitting}
              maxLength={120}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Production metrics"
              required
              value={displayName}
            />
          </label>
          <label className="siteDialog__field">
            <span>Streamable HTTP URL</span>
            <input
              disabled={isSubmitting}
              onChange={(event) => setMcpUrl(event.target.value)}
              placeholder="https://mcp.example.com/mcp"
              required
              spellCheck={false}
              type="url"
              value={mcpUrl}
            />
          </label>
          <label className="siteDialog__field">
            <span>Authentication</span>
            <select
              disabled={isSubmitting}
              onChange={(event) => setAuthType(event.target.value as AuthType)}
              value={authType}
            >
              <option value="api_token">API token</option>
              <option value="oauth">OAuth 2.0</option>
            </select>
          </label>
          {authType === "api_token" ? (
            <label className="siteDialog__field">
              <span>API token</span>
              <input
                autoComplete="off"
                disabled={isSubmitting}
                onChange={(event) => setApiToken(event.target.value)}
                placeholder="Paste a bearer token"
                required
                spellCheck={false}
                type="password"
                value={apiToken}
              />
            </label>
          ) : (
            <p className="siteDialog__oauthNote">
              You’ll continue to the MCP provider to approve access. The server
              must support MCP OAuth discovery and dynamic client registration.
            </p>
          )}

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
              disabled={isSubmitting || !complete}
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <span aria-hidden="true" className="buttonSpinner" />
                  {authType === "oauth" ? "Authorizing…" : "Verifying…"}
                </>
              ) : authType === "oauth" ? (
                "Continue with OAuth"
              ) : (
                "Connect MCP"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
