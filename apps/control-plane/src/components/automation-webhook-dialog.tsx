import { useEffect, useState } from "react";
import { type AutomationWebhook, fetchAutomationWebhook } from "../automations-api";

// An example request, with the token in single quotes so a shell keeps it as
// is.
function automationWebhookExample(webhook: AutomationWebhook): string {
  return [
    `curl -X POST '${webhook.url}' \\`,
    `  -H 'Authorization: Bearer ${webhook.token}' \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d '{"title":"Checkout errors are up","details":"Error rate is 12% on /api/checkout"}'`,
  ].join("\n");
}

// Shows where to send requests that start the automation.
export function AutomationWebhookDialog({
  automationId,
  open,
  onClose,
}: {
  automationId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [webhook, setWebhook] = useState<(AutomationWebhook & { automationId: string }) | null>(null);
  const [error, setError] = useState<{ automationId: string; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetchAutomationWebhook(automationId, controller.signal)
      .then((next) => setWebhook({ ...next, automationId }))
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError({
          automationId,
          message: caught instanceof Error ? caught.message : "Unable to load the webhook",
        });
      });
    return () => controller.abort();
  }, [automationId, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  const activeWebhook = webhook?.automationId === automationId ? webhook : null;
  const activeError = error?.automationId === automationId ? error.message : null;

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
        aria-labelledby="automation-webhook-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Webhook</span>
          <h2 id="automation-webhook-title">Send requests to this automation</h2>
          <p>Each POST request with the token starts a run. The request body is the run's trigger payload.</p>
        </header>
        <div className="siteDialog__form">
          <ol className="siteDialog__instructions">
            <li>Send a POST request to the webhook URL with the header <code>Authorization: Bearer</code> and the token.</li>
            <li>Send any body up to 1 MB. A JSON body with a <code>title</code> field names the run.</li>
            <li>To retry safely, send the same <code>Idempotency-Key</code> header. A repeated key does not start another run.</li>
          </ol>
          {activeWebhook ? (
            <>
              <label className="siteDialog__field">
                <span>Webhook URL</span>
                <input readOnly value={activeWebhook.url} />
              </label>
              <button className="button button--secondary button--small" onClick={() => copy("url", activeWebhook.url)} type="button">
                {copied === "url" ? "Copied" : "Copy webhook URL"}
              </button>
              <label className="siteDialog__field">
                <span>Token</span>
                <input readOnly type="password" value={activeWebhook.token} />
              </label>
              <button className="button button--secondary button--small" onClick={() => copy("token", activeWebhook.token)} type="button">
                {copied === "token" ? "Copied" : "Copy token"}
              </button>
              <button className="button button--secondary button--small" onClick={() => copy("example", automationWebhookExample(activeWebhook))} type="button">
                {copied === "example" ? "Copied" : "Copy curl example"}
              </button>
            </>
          ) : activeError ? (
            <p className="siteDialog__error" role="alert">{activeError}</p>
          ) : (
            <p className="siteDialog__oauthNote">Loading webhook…</p>
          )}
          <footer className="siteDialog__footer">
            <button className="button button--primary button--small" onClick={onClose} type="button">Done</button>
          </footer>
        </div>
      </section>
    </div>
  );
}
