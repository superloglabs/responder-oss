import { useCallback, useEffect, useState, type FormEvent } from "react";

export function Dash0ConnectionDialog({
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
  const [mcpUrl, setMcpUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setMcpUrl("");
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
        body: JSON.stringify({ mcpUrl, returnTo }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect Dash0");
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to connect Dash0");
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
        aria-labelledby="dash0-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Dash0</span>
          <h2 id="dash0-connection-title">Authorize observability access</h2>
          <p>
            Responder uses Dash0 OAuth and exposes only read-only telemetry tools.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <ol className="siteDialog__instructions">
            <li>Open <strong>Organization settings → Endpoints → MCP</strong> in Dash0.</li>
            <li>Copy the MCP endpoint URL for your region.</li>
            <li>Paste it below, then approve access in Dash0.</li>
          </ol>
          <label className="siteDialog__field">
            <span>MCP endpoint URL</span>
            <input
              autoComplete="off"
              autoFocus
              disabled={isSubmitting}
              maxLength={2_048}
              onChange={(event) => setMcpUrl(event.target.value)}
              placeholder="https://mcp.…dash0.com/mcp"
              required
              spellCheck={false}
              type="url"
              value={mcpUrl}
            />
          </label>
          <p className="siteDialog__oauthNote">
            Access is organization-scoped and can be revoked from Dash0 User Settings → Applications.
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
              disabled={isSubmitting || !mcpUrl.trim()}
              type="submit"
            >
              {isSubmitting ? (
                <><span aria-hidden="true" className="buttonSpinner" />Connecting…</>
              ) : "Continue to Dash0"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function Dash0WebhookSetupDialog({
  accountId,
  open,
  onClose,
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [configuration, setConfiguration] = useState<{
    accountId: string;
    authorization: string;
    webhookUrl: string;
  } | null>(null);
  const [error, setError] = useState<{
    accountId: string;
    message: string;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    void fetch(`/api/integrations/dash0/${encodeURIComponent(accountId)}/webhook-config`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { authorization?: string; error?: string; webhookUrl?: string }
          | null;
        if (!response.ok || !body?.authorization || !body.webhookUrl) {
          throw new Error(body?.error ?? "Unable to load webhook setup");
        }
        if (!cancelled) {
          setConfiguration({
            accountId,
            authorization: body.authorization,
            webhookUrl: body.webhookUrl,
          });
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError({
            accountId,
            message:
              caught instanceof Error
                ? caught.message
                : "Unable to load webhook setup",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, open]);

  if (!open) return null;

  const activeConfiguration =
    configuration?.accountId === accountId ? configuration : null;
  const activeError = error?.accountId === accountId ? error.message : null;

  async function copy(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1_500);
  }

  return (
    <div className="siteDialogBackdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        aria-labelledby="dash0-webhook-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Dash0 alerts</span>
          <h2 id="dash0-webhook-title">Add the Responder webhook</h2>
          <p>Configure this notification channel in Dash0 to start investigations for ongoing failed checks.</p>
        </header>
        <div className="siteDialog__form">
          <ol className="siteDialog__instructions">
            <li>Open <strong>Organization settings → Notification Channels</strong> in Dash0.</li>
            <li>Add a <strong>Webhook</strong> channel using the URL below.</li>
            <li>Add an HTTP header named <strong>Authorization</strong> with the value below.</li>
            <li>Route the check rules you want Responder to investigate to that channel.</li>
          </ol>
          {activeConfiguration ? (
            <>
              <label className="siteDialog__field">
                <span>Webhook URL</span>
                <input readOnly value={activeConfiguration.webhookUrl} />
              </label>
              <button className="button button--secondary button--small" onClick={() => copy("url", activeConfiguration.webhookUrl)} type="button">
                {copied === "url" ? "Copied" : "Copy webhook URL"}
              </button>
              <label className="siteDialog__field">
                <span>Authorization header value</span>
                <input readOnly type="password" value={activeConfiguration.authorization} />
              </label>
              <button className="button button--secondary button--small" onClick={() => copy("authorization", activeConfiguration.authorization)} type="button">
                {copied === "authorization" ? "Copied" : "Copy header value"}
              </button>
            </>
          ) : activeError ? (
            <p className="siteDialog__error" role="alert">{activeError}</p>
          ) : (
            <p className="siteDialog__oauthNote">Loading webhook setup…</p>
          )}
          <footer className="siteDialog__footer">
            <button className="button button--primary button--small" onClick={onClose} type="button">Done</button>
          </footer>
        </div>
      </section>
    </div>
  );
}
