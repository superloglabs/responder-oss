import { useEffect, useState } from "react";

interface BetterStackWebhookConfiguration {
  accountId: string;
  password: string;
  username: string;
  webhookUrl: string;
}

// Shows the outgoing incident webhook a Better Stack connection needs before
// its incidents can start automations.
export function BetterStackWebhookDialog({
  accountId,
  open,
  onClose,
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [configuration, setConfiguration] = useState<BetterStackWebhookConfiguration | null>(null);
  const [error, setError] = useState<{ accountId: string; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    void fetch(`/api/integrations/betterstack/${encodeURIComponent(accountId)}/webhook-config`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | Partial<Omit<BetterStackWebhookConfiguration, "accountId">> & { error?: string }
          | null;
        if (!response.ok || !body?.password || !body.username || !body.webhookUrl) {
          throw new Error(body?.error ?? "Unable to load webhook setup");
        }
        if (!cancelled) {
          setConfiguration({
            accountId,
            password: body.password,
            username: body.username,
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
        aria-labelledby="betterstack-webhook-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Better Stack incidents</span>
          <h2 id="betterstack-webhook-title">Add the Responder webhook</h2>
          <p>Each new incident starts the automation once. Acknowledged and resolved incidents are ignored.</p>
        </header>
        <div className="siteDialog__form">
          <ol className="siteDialog__instructions">
            <li>
              In Better Stack, open{" "}
              <a href="https://incidents.betterstack.com/team/0/integrations/exporting-data" rel="noreferrer" target="_blank">Integrations → Exporting data</a>{" "}
              and add an <strong>Incident webhook</strong> under Outgoing webhooks.
            </li>
            <li>Use the webhook URL below and turn on the <strong>Incident started</strong> event.</li>
            <li>Set basic authentication to the username and password below, and keep the default request body.</li>
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
                <span>Username</span>
                <input readOnly value={activeConfiguration.username} />
              </label>
              <label className="siteDialog__field">
                <span>Password</span>
                <input readOnly type="password" value={activeConfiguration.password} />
              </label>
              <button className="button button--secondary button--small" onClick={() => copy("password", activeConfiguration.password)} type="button">
                {copied === "password" ? "Copied" : "Copy password"}
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
