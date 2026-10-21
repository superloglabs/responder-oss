import { useEffect, useState } from "react";

interface SignozWebhookConfiguration {
  accountId: string;
  bearerToken: string;
  webhookUrl: string;
}

// Shows the webhook notification channel a SigNoz connection needs before its
// alerts can start automations.
export function SignozWebhookDialog({
  accountId,
  open,
  onClose,
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [configuration, setConfiguration] = useState<SignozWebhookConfiguration | null>(null);
  const [error, setError] = useState<{ accountId: string; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    void fetch(`/api/integrations/signoz/${encodeURIComponent(accountId)}/webhook-config`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | Partial<Omit<SignozWebhookConfiguration, "accountId">> & { error?: string }
          | null;
        if (!response.ok || !body?.bearerToken || !body.webhookUrl) {
          throw new Error(body?.error ?? "Unable to load webhook setup");
        }
        if (!cancelled) {
          setConfiguration({ accountId, bearerToken: body.bearerToken, webhookUrl: body.webhookUrl });
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError({
            accountId,
            message: caught instanceof Error ? caught.message : "Unable to load webhook setup",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  const activeConfiguration = configuration?.accountId === accountId ? configuration : null;
  const activeError = error?.accountId === accountId ? error.message : null;

  // The values stay visible in the fields when the clipboard is unavailable.
  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1_500);
  }

  return (
    <div className="siteDialogBackdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        aria-labelledby="signoz-webhook-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>SigNoz alerts</span>
          <h2 id="signoz-webhook-title">Add the Responder channel</h2>
          <p>Alert rules that notify this channel start the automation each time they fire.</p>
        </header>
        <div className="siteDialog__form">
          <ol className="siteDialog__instructions">
            <li>Open <strong>Settings → Alert Channels</strong> in SigNoz and create a <strong>Webhook</strong> channel.</li>
            <li>Use the webhook URL below.</li>
            <li>Leave <strong>Username</strong> empty and paste the token below as the <strong>Password</strong>.</li>
            <li>Select the channel in the alert rules that should start this automation.</li>
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
                <span>Password (bearer token)</span>
                <input readOnly type="password" value={activeConfiguration.bearerToken} />
              </label>
              <button className="button button--secondary button--small" onClick={() => copy("token", activeConfiguration.bearerToken)} type="button">
                {copied === "token" ? "Copied" : "Copy token"}
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
