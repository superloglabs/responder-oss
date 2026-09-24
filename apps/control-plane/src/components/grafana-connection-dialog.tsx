import { useCallback, useEffect, useState, type FormEvent } from "react";

type GrafanaDeployment = "cloud" | "self_hosted";

export function GrafanaConnectionDialog({
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
  const [deployment, setDeployment] = useState<GrafanaDeployment>("cloud");
  const [stackUrl, setStackUrl] = useState("");
  const [grafanaUrl, setGrafanaUrl] = useState("");
  const [serviceAccountToken, setServiceAccountToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setDeployment("cloud");
    setStackUrl("");
    setGrafanaUrl("");
    setServiceAccountToken("");
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
        body: JSON.stringify(
          deployment === "cloud"
            ? { deployment, returnTo, stackUrl }
            : { deployment, grafanaUrl, returnTo, serviceAccountToken },
        ),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect Grafana");
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to connect Grafana",
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
        aria-labelledby="grafana-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Grafana</span>
          <h2 id="grafana-connection-title">Choose your deployment</h2>
          <p>
            Grafana Cloud connects through Grafana&apos;s hosted MCP server and
            OAuth. Self-hosted Grafana uses its URL and a service account token.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <label className="siteDialog__field">
            <span>Deployment</span>
            <select
              autoFocus
              disabled={isSubmitting}
              onChange={(event) => {
                setDeployment(event.target.value as GrafanaDeployment);
                setError(null);
              }}
              value={deployment}
            >
              <option value="cloud">Grafana Cloud</option>
              <option value="self_hosted">Self-hosted Grafana</option>
            </select>
          </label>

          {deployment === "cloud" ? (
            <>
              <ol className="siteDialog__instructions">
                <li>Enter the URL of the Grafana Cloud stack to connect.</li>
                <li>
                  Continue and approve read and query access in Grafana Cloud.
                  Responder does not request write access.
                </li>
              </ol>
              <label className="siteDialog__field">
                <span>Stack URL</span>
                <input
                  autoComplete="off"
                  disabled={isSubmitting}
                  onChange={(event) => setStackUrl(event.target.value)}
                  placeholder="https://your-stack.grafana.net"
                  required
                  spellCheck={false}
                  value={stackUrl}
                />
              </label>
            </>
          ) : (
            <>
              <ol className="siteDialog__instructions">
                <li>
                  In Grafana, open{" "}
                  <strong>Administration → Users and access → Service accounts</strong>{" "}
                  and add a service account with the <strong>Viewer</strong> role.
                </li>
                <li>Add a token to that service account and copy it.</li>
                <li>
                  Paste the Grafana URL and token below. The URL must be
                  reachable over public HTTPS.
                </li>
              </ol>
              <label className="siteDialog__field">
                <span>Grafana URL</span>
                <input
                  disabled={isSubmitting}
                  onChange={(event) => setGrafanaUrl(event.target.value)}
                  placeholder="https://grafana.example.com"
                  required
                  spellCheck={false}
                  type="url"
                  value={grafanaUrl}
                />
              </label>
              <label className="siteDialog__field">
                <span>Service account token</span>
                <input
                  autoComplete="off"
                  disabled={isSubmitting}
                  onChange={(event) => setServiceAccountToken(event.target.value)}
                  placeholder="glsa_…"
                  required
                  spellCheck={false}
                  type="password"
                  value={serviceAccountToken}
                />
              </label>
            </>
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
              disabled={
                isSubmitting ||
                (deployment === "cloud"
                  ? !stackUrl.trim()
                  : !grafanaUrl.trim() || !serviceAccountToken.trim())
              }
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <span aria-hidden="true" className="buttonSpinner" />
                  {deployment === "cloud" ? "Redirecting…" : "Verifying…"}
                </>
              ) : (
                deployment === "cloud"
                  ? "Continue with Grafana Cloud"
                  : "Connect Grafana"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
