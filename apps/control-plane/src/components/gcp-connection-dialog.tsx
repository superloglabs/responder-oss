import { useCallback, useEffect, useState, type FormEvent } from "react";

export interface GcpProjectOption {
  displayName: string;
  projectId: string;
  projectNumber: string;
}

interface GcpSetup {
  accountId: string;
  projectId: string;
  script: string;
}

async function prepareProject(
  connectUrl: string,
  project: GcpProjectOption,
  returnTo: string,
): Promise<GcpSetup> {
  const response = await fetch(connectUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...project, returnTo }),
  });
  const body = (await response.json().catch(() => null)) as
    | (Partial<GcpSetup> & { error?: string })
    | null;
  if (!response.ok || !body?.accountId || !body.projectId || !body.script) {
    throw new Error(body?.error ?? `Unable to prepare ${project.projectId}`);
  }
  return body as GcpSetup;
}

export function GcpConnectionDialog({
  connectUrl,
  open,
  onCancel,
  returnTo,
  initialProject,
}: {
  connectUrl: string;
  open: boolean;
  onCancel: () => void;
  returnTo: string;
  initialProject?: GcpProjectOption;
}) {
  const [projectId, setProjectId] = useState(initialProject?.projectId ?? "");
  const [projectNumber, setProjectNumber] = useState(initialProject?.projectNumber ?? "");
  const [setups, setSetups] = useState<GcpSetup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const cancel = useCallback(() => {
    if (isSubmitting) return;
    setProjectId("");
    setProjectNumber("");
    setSetups([]);
    setError(null);
    onCancel();
  }, [isSubmitting, onCancel]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cancel, open]);

  async function prepareProjectConnection(project: GcpProjectOption) {
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      setSetups([await prepareProject(connectUrl, project, returnTo)]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to prepare Google Cloud access",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function prepareManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await prepareProjectConnection({ displayName: projectId, projectId, projectNumber });
  }

  async function verify() {
    if (setups.length === 0 || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const redirects = await Promise.all(
        setups.map(async (setup) => {
          const response = await fetch(connectUrl.replace(/\/connect$/u, "/verify"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              integrationAccountId: setup.accountId,
              returnTo,
            }),
          });
          const body = (await response.json().catch(() => null)) as
            | { error?: string; redirectUrl?: string }
            | null;
          if (!response.ok || !body?.redirectUrl) {
            throw new Error(
              body?.error ?? `Unable to verify ${setup.projectId}`,
            );
          }
          return body.redirectUrl;
        }),
      );
      window.location.assign(redirects.at(-1)!);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to verify Google Cloud access",
      );
      setIsSubmitting(false);
    }
  }

  function downloadScript() {
    if (setups.length === 0) return;
    const script = setups
      .map(({ projectId: selectedProjectId, script }) =>
        `\n# Responder access for ${selectedProjectId}\n${script}`,
      )
      .join("\n");
    const url = URL.createObjectURL(
      new Blob([script], { type: "text/x-shellscript" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "responder-gcp-access.sh";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  if (!open) return null;

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <section
        aria-labelledby="gcp-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Google Cloud</span>
          <h2 id="gcp-connection-title">
            {setups.length > 0
              ? "Create the investigation identities"
              : "Add a GCP project"}
          </h2>
          <p>
            Responder receives short-lived, read-only tokens. No service-account
            keys are created or stored.
          </p>
        </header>

        {setups.length > 0 ? (
          <div className="siteDialog__form">
            <ol className="siteDialog__instructions">
              <li>Download the setup script.</li>
              <li>
                Open Cloud Shell and run <code>bash responder-gcp-access.sh</code>.
                It will configure {setups.length} project
                {setups.length === 1 ? "" : "s"}.
              </li>
              <li>Return here after the script reports that access is ready.</li>
            </ol>
            {error ? <p className="siteDialog__error" role="alert">{error}</p> : null}
            <footer className="siteDialog__footer siteDialog__footer--wrap">
              <button
                className="button button--secondary button--small"
                onClick={downloadScript}
                type="button"
              >
                Download script
              </button>
              <button
                className="button button--secondary button--small"
                onClick={() => window.open(
                  `https://console.cloud.google.com/cloudshell/editor?project=${encodeURIComponent(setups[0]!.projectId)}`,
                  "_blank",
                  "noopener,noreferrer",
                )}
                type="button"
              >
                Open Cloud Shell
              </button>
              <button
                className="button button--primary button--small"
                disabled={isSubmitting}
                onClick={() => void verify()}
                type="button"
              >
                {isSubmitting ? "Verifying…" : "Verify connections"}
              </button>
            </footer>
          </div>
        ) : (
          <form className="siteDialog__form" onSubmit={prepareManual}>
            <label className="siteDialog__field">
              <span>Project ID</span>
              <input
                autoFocus
                disabled={isSubmitting}
                maxLength={30}
                minLength={6}
                onChange={(event) => setProjectId(event.target.value.toLowerCase())}
                placeholder="my-production-project"
                required
                value={projectId}
              />
            </label>
            <label className="siteDialog__field">
              <span>Project number</span>
              <input
                disabled={isSubmitting}
                inputMode="numeric"
                maxLength={20}
                minLength={1}
                onChange={(event) =>
                  setProjectNumber(event.target.value.replace(/\D/gu, ""))
                }
                placeholder="123456789012"
                required
                value={projectNumber}
              />
            </label>
            <p className="siteDialog__oauthNote">
              Find both values in the{" "}
              <a
                href="https://console.cloud.google.com/cloud-resource-manager"
                rel="noreferrer"
                target="_blank"
              >
                Google Cloud project selector
              </a>
              . Access is limited to asset metadata, logs, metrics, and alerting
              state.
            </p>
            {error ? <p className="siteDialog__error" role="alert">{error}</p> : null}
            <footer className="siteDialog__footer">
              <button
                className="button button--secondary button--small"
                onClick={cancel}
                type="button"
              >
                Cancel
              </button>
              <button
                className="button button--primary button--small"
                disabled={isSubmitting || projectId.length < 6 || projectNumber.length < 1}
                type="submit"
              >
                {isSubmitting ? "Preparing…" : "Continue"}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
