import { useEffect, useState } from "react";

interface AxiomWebhookConfiguration {
  accountId: string;
  authorization: string;
  bodyTemplate: string;
  webhookUrl: string;
}

// Shows the custom webhook notifier an Axiom connection needs before its
// monitor alerts can start automations.
export function AxiomWebhookDialog({
  accountId,
  open,
  onClose,
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [configuration, setConfiguration] = useState<AxiomWebhookConfiguration | null>(null);
  const [error, setError] = useState<{ accountId: string; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    void fetch(`/api/integrations/axiom/${encodeURIComponent(accountId)}/webhook-config`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | Partial<Omit<AxiomWebhookConfiguration, "accountId">> & { error?: string }
          | null;
        if (!response.ok || !body?.authorization || !body.bodyTemplate || !body.webhookUrl) {
          throw new Error(body?.error ?? "Unable to load webhook setup");
        }
        if (!cancelled) {
          setConfiguration({
            accountId,
            authorization: body.authorization,
            bodyTemplate: body.bodyTemplate,
            webhookUrl: body.webhookUrl,
          });
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
        aria-labelledby="axiom-webhook-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Axiom alerts</span>
          <h2 id="axiom-webhook-title">Add the Responder notifier</h2>
          <p>Monitors that use this notifier start the automation each time they alert.</p>
        </header>
        <div className="siteDialog__form">
          <ol className="siteDialog__instructions">
            <li>Open <strong>Monitors → Notifiers</strong> in Axiom and create a <strong>Custom webhook</strong> notifier.</li>
            <li>Use the webhook URL below.</li>
            <li>Add a header named <strong>Authorization</strong> with the value below.</li>
            <li>Replace the body with the template below.</li>
            <li>Add the notifier to the monitors that should start this automation.</li>
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
              <label className="siteDialog__field">
                <span>Body</span>
                <textarea readOnly rows={4} value={activeConfiguration.bodyTemplate} />
              </label>
              <button className="button button--secondary button--small" onClick={() => copy("body", activeConfiguration.bodyTemplate)} type="button">
                {copied === "body" ? "Copied" : "Copy body"}
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
