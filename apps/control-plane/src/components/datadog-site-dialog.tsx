import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

const DATADOG_SITES = [
  {
    id: "datadoghq.com",
    name: "US1",
    location: "United States",
    appUrl: "https://app.datadoghq.com",
  },
  {
    id: "datadoghq.eu",
    name: "EU1",
    location: "Europe",
    appUrl: "https://app.datadoghq.eu",
  },
  {
    id: "us3.datadoghq.com",
    name: "US3",
    location: "United States",
    appUrl: "https://us3.datadoghq.com",
  },
  {
    id: "us5.datadoghq.com",
    name: "US5",
    location: "United States",
    appUrl: "https://us5.datadoghq.com",
  },
  {
    id: "ap1.datadoghq.com",
    name: "AP1",
    location: "Asia Pacific",
    appUrl: "https://ap1.datadoghq.com",
  },
  {
    id: "ap2.datadoghq.com",
    name: "AP2",
    location: "Asia Pacific",
    appUrl: "https://ap2.datadoghq.com",
  },
  {
    id: "uk1.datadoghq.com",
    name: "UK1",
    location: "United Kingdom",
    appUrl: "https://uk1.datadoghq.com",
  },
] as const;

export type DatadogSiteId = (typeof DATADOG_SITES)[number]["id"];

export function DatadogConnectionDialog({
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
  const [site, setSite] = useState<DatadogSiteId>("datadoghq.com");
  const [apiKey, setApiKey] = useState("");
  const [applicationKey, setApplicationKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const selectedSite = useMemo(
    () => DATADOG_SITES.find((candidate) => candidate.id === site)!,
    [site],
  );
  const cancel = useCallback(() => {
    setApiKey("");
    setApplicationKey("");
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
        body: JSON.stringify({ apiKey, applicationKey, returnTo, site }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect Datadog");
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to connect Datadog",
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
        aria-labelledby="datadog-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Datadog</span>
          <h2 id="datadog-connection-title">Add your Datadog keys</h2>
          <p>
            Responder validates these credentials, encrypts them, and only uses
            them from the server-side agent connection.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <label className="siteDialog__field">
            <span>Datadog site</span>
            <select
              autoFocus
              disabled={isSubmitting}
              onChange={(event) => setSite(event.target.value as DatadogSiteId)}
              value={site}
            >
              {DATADOG_SITES.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} — {candidate.location}
                </option>
              ))}
            </select>
          </label>

          <ol className="siteDialog__instructions">
            <li>
              Open{" "}
              <a
                href={`${selectedSite.appUrl}/organization-settings/api-keys`}
                rel="noreferrer"
                target="_blank"
              >
                API Keys
              </a>{" "}
              and create or copy a key.
            </li>
            <li>
              Open{" "}
              <a
                href={`${selectedSite.appUrl}/organization-settings/application-keys`}
                rel="noreferrer"
                target="_blank"
              >
                Application Keys
              </a>{" "}
              and create a scoped key owned by you or a service account. Copy
              the secret when Datadog shows it.
            </li>
            <li>Paste both keys below and connect.</li>
          </ol>

          <label className="siteDialog__field">
            <span>API key</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste your Datadog API key"
              required
              spellCheck={false}
              type="password"
              value={apiKey}
            />
          </label>
          <label className="siteDialog__field">
            <span>Application key</span>
            <input
              autoComplete="off"
              disabled={isSubmitting}
              onChange={(event) => setApplicationKey(event.target.value)}
              placeholder="Paste your Datadog application key"
              required
              spellCheck={false}
              type="password"
              value={applicationKey}
            />
          </label>

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
              disabled={isSubmitting || !apiKey.trim() || !applicationKey.trim()}
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <span aria-hidden="true" className="buttonSpinner" />
                  Verifying…
                </>
              ) : (
                "Connect Datadog"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
