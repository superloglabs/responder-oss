import { useCallback, useEffect, useState, type FormEvent } from "react";

const CLICKSTACK_CLOUD_MCP_URL = "https://mcp.clickhouse.cloud/clickstack";
type ClickStackDeployment = "cloud" | "self_hosted";

export function ClickStackConnectionDialog({
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
  const [deployment, setDeployment] = useState<ClickStackDeployment>("cloud");
  const [serviceId, setServiceId] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setDeployment("cloud");
    setServiceId("");
    setMcpUrl("");
    setAccessKey("");
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
            ? { deployment, returnTo, serviceId }
            : { accessKey, deployment, mcpUrl, returnTo },
        ),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect ClickStack / HyperDX");
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to connect ClickStack / HyperDX",
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
        aria-labelledby="clickstack-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect ClickStack / HyperDX</span>
          <h2 id="clickstack-connection-title">Choose your deployment</h2>
          <p>
            Cloud connects through ClickHouse OAuth. Self-hosted ClickStack uses
            its MCP URL and a Personal API Access Key.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <label className="siteDialog__field">
            <span>Deployment</span>
            <select
              autoFocus
              disabled={isSubmitting}
              onChange={(event) => {
                setDeployment(event.target.value as ClickStackDeployment);
                setError(null);
              }}
              value={deployment}
            >
              <option value="cloud">ClickStack Cloud</option>
              <option value="self_hosted">Self-hosted ClickStack</option>
            </select>
          </label>

          {deployment === "cloud" ? (
            <>
              <ol className="siteDialog__instructions">
                <li>In ClickHouse Cloud, open your ClickStack service.</li>
                <li>
                  Open <strong>Connect → MCP</strong> and copy its service ID.
                </li>
                <li>Continue and approve access in ClickHouse Cloud.</li>
              </ol>
              <label className="siteDialog__field">
                <span>MCP URL</span>
                <input disabled readOnly value={CLICKSTACK_CLOUD_MCP_URL} />
              </label>
              <label className="siteDialog__field">
                <span>ClickHouse service ID</span>
                <input
                  autoComplete="off"
                  disabled={isSubmitting}
                  onChange={(event) => setServiceId(event.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  required
                  spellCheck={false}
                  value={serviceId}
                />
              </label>
            </>
          ) : (
            <>
              <ol className="siteDialog__instructions">
                <li>
                  In ClickStack, open <strong>Team Settings → API Keys</strong>{" "}
                  and copy your Personal API Access Key.
                </li>
                <li>
                  Copy the full MCP URL, usually ending in <code>/api/mcp</code>.
                </li>
                <li>Paste both values below and connect.</li>
              </ol>
              <label className="siteDialog__field">
                <span>MCP URL</span>
                <input
                  disabled={isSubmitting}
                  onChange={(event) => setMcpUrl(event.target.value)}
                  placeholder="https://clickstack.example.com/api/mcp"
                  required
                  spellCheck={false}
                  type="url"
                  value={mcpUrl}
                />
              </label>
              <label className="siteDialog__field">
                <span>Personal API Access Key</span>
                <input
                  autoComplete="off"
                  disabled={isSubmitting}
                  onChange={(event) => setAccessKey(event.target.value)}
                  placeholder="Paste your ClickStack access key"
                  required
                  spellCheck={false}
                  type="password"
                  value={accessKey}
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
                  ? !serviceId.trim()
                  : !mcpUrl.trim() || !accessKey.trim())
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
                  ? "Continue with ClickHouse Cloud"
                  : "Connect ClickStack / HyperDX"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
