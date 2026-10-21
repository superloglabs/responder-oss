import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDialogFocusTrap } from "../use-dialog-focus-trap";

const honeycombConnectUrl = "/api/integrations/honeycomb/connect";

const honeycombRegions = [
  { id: "us", name: "US", uiUrl: "https://ui.honeycomb.io" },
  { id: "eu", name: "EU", uiUrl: "https://ui.eu1.honeycomb.io" },
] as const;

type HoneycombRegionId = (typeof honeycombRegions)[number]["id"];

// Connects a Honeycomb team with a management API key. Without onConnected,
// the page follows the returned redirect. The trigger editor sits inside the
// automation form, and forms cannot nest, so the fields are not a form of
// their own.
export function HoneycombConnectionDialog({
  open,
  onCancel,
  onConnected,
  returnTo,
}: {
  open: boolean;
  onCancel: () => void;
  onConnected?: () => void;
  returnTo: string;
}) {
  const [region, setRegion] = useState<HoneycombRegionId>("us");
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(dialogRef, open);
  const cancel = useCallback(() => {
    setKeySecret("");
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

  const ready = Boolean(keyId.trim() && keySecret.trim());
  const selectedRegion = honeycombRegions.find((candidate) => candidate.id === region)!;

  async function connect() {
    if (isSubmitting || !ready) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(honeycombConnectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyId, keySecret, region, returnTo }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect Honeycomb");
      }
      if (onConnected) {
        setKeySecret("");
        setIsSubmitting(false);
        onConnected();
        return;
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to connect Honeycomb");
      setIsSubmitting(false);
    }
  }

  if (!open) return null;

  const submitOnEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void connect();
  };

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) cancel();
      }}
    >
      <section
        ref={dialogRef}
        aria-labelledby="honeycomb-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Honeycomb</span>
          <h2 id="honeycomb-connection-title">Add a Honeycomb management key</h2>
          <p>
            Responder verifies the key, encrypts it, and uses it only from the
            server to reach Honeycomb's MCP server.
          </p>
        </header>

        <div className="siteDialog__form">
          <label className="siteDialog__field">
            <span>Region</span>
            <select
              disabled={isSubmitting}
              onChange={(event) => setRegion(event.target.value as HoneycombRegionId)}
              value={region}
            >
              {honeycombRegions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} — {new URL(candidate.uiUrl).host}
                </option>
              ))}
            </select>
          </label>
          <ol className="siteDialog__instructions">
            <li>
              In{" "}
              <a href={selectedRegion.uiUrl} rel="noreferrer" target="_blank">Honeycomb</a>,
              open <strong>Team Settings → API Keys → Management Keys</strong> and create a key. Only team owners can.
            </li>
            <li>Give it read access to <strong>Model Context Protocol</strong> and <strong>Environments</strong>.</li>
            <li>Paste the key ID and secret below.</li>
          </ol>
          <label className="siteDialog__field">
            <span>Key ID</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              maxLength={512}
              onChange={(event) => setKeyId(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="hcxmk_…"
              required
              spellCheck={false}
              value={keyId}
            />
          </label>
          <label className="siteDialog__field">
            <span>Key secret</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              maxLength={4_096}
              onChange={(event) => setKeySecret(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="Paste the key secret"
              required
              spellCheck={false}
              type="password"
              value={keySecret}
            />
          </label>

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
              disabled={isSubmitting || !ready}
              onClick={() => void connect()}
              type="button"
            >
              {isSubmitting ? (
                <><span aria-hidden="true" className="buttonSpinner" />Verifying…</>
              ) : "Connect Honeycomb"}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
