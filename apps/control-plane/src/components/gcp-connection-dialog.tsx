import { useCallback, useEffect, useState, type FormEvent } from "react";
import { type GcpSetupStatus, useGcpSetupStatus } from "../gcp-setup-status";
import { GcpSetupStepper } from "./gcp-setup-progress";

interface GcpProject {
  name: string;
  projectId: string;
  projectNumber: string;
}

function gcpEndpoint(connectUrl: string, endpoint: string): string {
  const parts = connectUrl.split("?")[0]!.split("/");
  parts.pop();
  return `${parts.join("/")}/${endpoint}`;
}

function connectedRedirect(returnTo: string, accountId: string): string {
  const url = new URL(returnTo, window.location.origin);
  url.searchParams.set("integration", "gcp");
  url.searchParams.set("status", "connected");
  url.searchParams.set("integration_account_id", accountId);
  return `${url.pathname}${url.search}`;
}

export function GcpConnectionDialog({
  connectUrl,
  open,
  onCancel,
  returnTo,
  selectionState,
}: {
  connectUrl: string;
  open: boolean;
  onCancel: () => void;
  returnTo: string;
  selectionState?: string | null;
}) {
  const selectingProject = Boolean(selectionState);
  const [projects, setProjects] = useState<GcpProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [started, setStarted] = useState<{
    accountId: string;
    setup: GcpSetupStatus;
  } | null>(null);
  const setup = useGcpSetupStatus(
    started?.accountId ?? null,
    started?.setup ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const cancel = useCallback(() => {
    if (started) {
      // Setup continues in the background; reload so the tile shows it.
      window.location.assign(new URL(returnTo, window.location.origin).pathname);
      return;
    }
    if (selectingProject) {
      const url = new URL(window.location.href);
      url.searchParams.delete("integration");
      url.searchParams.delete("status");
      url.searchParams.delete("selection_state");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setProjects([]);
    setProjectId("");
    setError(null);
    setIsSubmitting(false);
    onCancel();
  }, [onCancel, returnTo, selectingProject, started]);

  useEffect(() => {
    if (started && setup?.status === "succeeded") {
      window.location.assign(connectedRedirect(returnTo, started.accountId));
    }
  }, [returnTo, setup?.status, started]);

  useEffect(() => {
    if (!open || !selectionState || !connectUrl) return;
    let ignore = false;
    const projectsUrl = new URL(
      gcpEndpoint(connectUrl, "projects"),
      window.location.origin,
    );
    projectsUrl.searchParams.set("state", selectionState);
    void fetch(`${projectsUrl.pathname}${projectsUrl.search}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { error?: string; projects?: GcpProject[] }
          | null;
        if (!response.ok || !body?.projects) {
          throw new Error(body?.error ?? "Unable to load Google Cloud projects");
        }
        if (ignore) return;
        setProjects(body.projects);
        setProjectId(body.projects[0]?.projectId ?? "");
      })
      .catch((caught) => {
        if (!ignore) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to load Google Cloud projects",
          );
        }
      });
    return () => {
      ignore = true;
    };
  }, [connectUrl, open, selectionState]);

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
    if (!selectingProject) {
      setIsSubmitting(true);
      const url = new URL(connectUrl, window.location.origin);
      url.searchParams.set("returnTo", returnTo);
      window.location.assign(`${url.pathname}${url.search}`);
      return;
    }
    if (!projectId || started) return;
    setIsSubmitting(true);
    try {
      const response = await fetch(gcpEndpoint(connectUrl, "select-project"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, selectionState }),
      });
      const body = (await response.json().catch(() => null)) as
        | { accountId?: string; error?: string; setup?: GcpSetupStatus }
        | null;
      if (!response.ok || !body?.accountId || !body.setup) {
        throw new Error(body?.error ?? "Unable to start Google Cloud setup");
      }
      setStarted({ accountId: body.accountId, setup: body.setup });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to start Google Cloud setup",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!open) return null;

  const loadingProjects = selectingProject && projects.length === 0 && !error;
  const selectedProject = projects.find((project) => project.projectId === projectId);

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) cancel();
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
            {setup
              ? `Setting up ${selectedProject?.projectId ?? "the project"}`
              : selectingProject ? "Choose a project" : "Add a GCP project"}
          </h2>
          <p>
            Responder receives short-lived, read-only tokens. No service-account
            keys are created or stored.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          {setup ? (
            <>
              <GcpSetupStepper setup={setup} />
              <p className="siteDialog__oauthNote" aria-live="polite">
                {setup.status === "failed"
                  ? null
                  : setup.status === "succeeded"
                    ? "Connected. Returning to Responder…"
                    : "You can close this window. Setup continues, and the Google Cloud tile in Settings shows its progress."}
              </p>
              {setup.status === "failed" && setup.message ? (
                <p className="siteDialog__error" role="alert">{setup.message}</p>
              ) : null}
            </>
          ) : selectingProject ? (
            <>
              <label className="siteDialog__field">
                <span>Google Cloud project</span>
                <select
                  autoFocus
                  disabled={loadingProjects || isSubmitting}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                    setError(null);
                  }}
                  value={projectId}
                >
                  {projects.map((project) => (
                    <option key={project.projectId} value={project.projectId}>
                      {project.name === project.projectId
                        ? project.projectId
                        : `${project.name} — ${project.projectId}`}
                    </option>
                  ))}
                </select>
              </label>
              <p className="siteDialog__oauthNote">
                {loadingProjects
                  ? "Loading projects from your Google account…"
                  : `Responder will create a responder-investigation service account in ${selectedProject?.projectId ?? "this project"} with Logs Viewer, Monitoring Viewer, and Cloud Asset Viewer roles. Your Google sign-in is revoked when setup finishes.`}
              </p>
            </>
          ) : (
            <ol className="siteDialog__instructions">
              <li>
                Sign in with a Google account that is an Owner of the project.
              </li>
              <li>
                Choose the project. Responder creates a read-only{" "}
                <code>responder-investigation</code> service account and a
                keyless link to Responder.
              </li>
              <li>
                Responder revokes your Google sign-in when setup finishes. To
                remove access later, delete that service account.
              </li>
            </ol>
          )}

          {error ? <p className="siteDialog__error" role="alert">{error}</p> : null}

          <footer className="siteDialog__footer">
            <button
              className="button button--secondary button--small"
              onClick={cancel}
              type="button"
            >
              {setup ? "Close" : "Cancel"}
            </button>
            {setup ? null : (
              <button
                className="button button--primary button--small"
                disabled={isSubmitting || loadingProjects || (selectingProject && !projectId)}
                type="submit"
              >
                {isSubmitting ? (
                  <><span aria-hidden="true" className="buttonSpinner" />{selectingProject ? "Starting…" : "Redirecting…"}</>
                ) : selectingProject ? (
                  "Grant read-only access"
                ) : (
                  "Continue with Google"
                )}
              </button>
            )}
          </footer>
        </form>
      </section>
    </div>
  );
}
