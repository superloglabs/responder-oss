import { useCallback, useEffect, useState, type FormEvent } from "react";

const LANGFUSE_DEPLOYMENTS = [
  { id: "cloud_eu", name: "Langfuse Cloud (EU)", baseUrl: "https://cloud.langfuse.com" },
  { id: "cloud_us", name: "Langfuse Cloud (US)", baseUrl: "https://us.cloud.langfuse.com" },
  { id: "cloud_jp", name: "Langfuse Cloud (Japan)", baseUrl: "https://jp.cloud.langfuse.com" },
  { id: "cloud_hipaa", name: "Langfuse Cloud (HIPAA US)", baseUrl: "https://hipaa.cloud.langfuse.com" },
  { id: "self_hosted", name: "Self-hosted Langfuse", baseUrl: "" },
] as const;

type LangfuseDeployment = (typeof LANGFUSE_DEPLOYMENTS)[number]["id"];

export function LangfuseConnectionDialog({
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
  const [deployment, setDeployment] = useState<LangfuseDeployment>("cloud_eu");
  const [selfHostedUrl, setSelfHostedUrl] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setDeployment("cloud_eu");
    setSelfHostedUrl("");
    setPublicKey("");
    setSecretKey("");
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
    const selected = LANGFUSE_DEPLOYMENTS.find((item) => item.id === deployment)!;
    const baseUrl = deployment === "self_hosted" ? selfHostedUrl : selected.baseUrl;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(connectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl, publicKey, returnTo, secretKey }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect Langfuse");
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to connect Langfuse",
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
        aria-labelledby="langfuse-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Langfuse</span>
          <h2 id="langfuse-connection-title">Add project context</h2>
          <p>
            Responder encrypts the project keys and exposes only reviewed,
            read-only investigation tools.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <label className="siteDialog__field">
            <span>Deployment</span>
            <select
              autoFocus
              disabled={isSubmitting}
              onChange={(event) => {
                setDeployment(event.target.value as LangfuseDeployment);
                setError(null);
              }}
              value={deployment}
            >
              {LANGFUSE_DEPLOYMENTS.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          {deployment === "self_hosted" ? (
            <label className="siteDialog__field">
              <span>Deployment URL</span>
              <input
                disabled={isSubmitting}
                maxLength={2_048}
                onChange={(event) => setSelfHostedUrl(event.target.value)}
                placeholder="https://langfuse.example.com"
                required
                spellCheck={false}
                type="url"
                value={selfHostedUrl}
              />
            </label>
          ) : null}
          <ol className="siteDialog__instructions">
            <li>Open the Langfuse project you want the Agent to inspect.</li>
            <li>Open <strong>Project Settings → API Keys</strong>.</li>
            <li>Create a dedicated key pair and paste both values below.</li>
          </ol>
          <label className="siteDialog__field">
            <span>Project public key</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              maxLength={512}
              onChange={(event) => setPublicKey(event.target.value)}
              placeholder="pk-lf-…"
              required
              spellCheck={false}
              value={publicKey}
            />
          </label>
          <label className="siteDialog__field">
            <span>Project secret key</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              maxLength={4_096}
              onChange={(event) => setSecretKey(event.target.value)}
              placeholder="sk-lf-…"
              required
              spellCheck={false}
              type="password"
              value={secretKey}
            />
          </label>
          <p className="siteDialog__oauthNote">
            Langfuse does not currently offer delegated OAuth for project data.
            Responder blocks write tools even though project keys can authorize them.
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
              disabled={
                isSubmitting ||
                !publicKey.trim() ||
                !secretKey.trim() ||
                (deployment === "self_hosted" && !selfHostedUrl.trim())
              }
              type="submit"
            >
              {isSubmitting ? (
                <><span aria-hidden="true" className="buttonSpinner" />Verifying…</>
              ) : "Connect Langfuse"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
