import { useEffect, useState } from "react";

interface HoneycombWebhookConfiguration {
  accountId: string;
  sharedSecret: string;
  webhookUrl: string;
}

// Shows the webhook recipient a Honeycomb connection needs before its
// triggers and SLO burn alerts can start automations.
export function HoneycombWebhookDialog({
  accountId,
  open,
  onClose,
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [configuration, setConfiguration] = useState<HoneycombWebhookConfiguration | null>(null);
  const [error, setError] = useState<{ accountId: string; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    void fetch(`/api/integrations/honeycomb/${encodeURIComponent(accountId)}/webhook-config`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | Partial<Omit<HoneycombWebhookConfiguration, "accountId">> & { error?: string }
          | null;
        if (!response.ok || !body?.sharedSecret || !body.webhookUrl) {
          throw new Error(body?.error ?? "Unable to load webhook setup");
        }
        if (!cancelled) {
          setConfiguration({ accountId, sharedSecret: body.sharedSecret, webhookUrl: body.webhookUrl });
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
        aria-labelledby="honeycomb-webhook-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Honeycomb alerts</span>
          <h2 id="honeycomb-webhook-title">Add the Responder webhook</h2>
          <p>Triggers and SLO burn alerts that notify this webhook start the automation each time they fire.</p>
        </header>
        <div className="siteDialog__form">
          <ol className="siteDialog__instructions">
            <li>Open <strong>Team Settings → Integrations</strong> in Honeycomb and add a <strong>Webhook</strong>.</li>
            <li>Use the webhook URL and shared secret below, and keep the default payload.</li>
            <li>Add the webhook as a recipient on the triggers and burn alerts that should start this automation.</li>
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
                <span>Shared secret</span>
                <input readOnly type="password" value={activeConfiguration.sharedSecret} />
              </label>
              <button className="button button--secondary button--small" onClick={() => copy("secret", activeConfiguration.sharedSecret)} type="button">
                {copied === "secret" ? "Copied" : "Copy shared secret"}
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
