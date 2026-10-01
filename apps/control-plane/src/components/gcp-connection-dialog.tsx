import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

interface GcpProject {
  name: string;
  projectId: string;
  projectNumber: string;
}

type GcpSetupStep =
  | "enabling_apis"
  | "creating_identity_pool"
  | "creating_identity_provider"
  | "granting_access"
  | "waiting_for_google";

const SETUP_STEP_LABELS: Record<GcpSetupStep, string> = {
  enabling_apis: "Enabling the required Google Cloud APIs…",
  creating_identity_pool: "Creating the Responder identity pool…",
  creating_identity_provider: "Linking the identity pool to Responder…",
  granting_access: "Granting the read-only roles…",
  waiting_for_google: "Waiting for Google to apply the new access…",
};

const SETUP_POLL_INTERVAL_MS = 3_000;
// Google documents that IAM changes usually apply within two minutes and can
// take up to seven.
const SETUP_TIMEOUT_MS = 8 * 60 * 1_000;

function gcpEndpoint(connectUrl: string, endpoint: string): string {
  const parts = connectUrl.split("?")[0]!.split("/");
  parts.pop();
  return `${parts.join("/")}/${endpoint}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error ?? "Google Cloud setup failed. Try again.");
  }
  return payload;
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
  const [step, setStep] = useState<GcpSetupStep | null>(null);
  const [setupState, setSetupState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancelled = useRef(false);

  const cancel = useCallback(() => {
    cancelled.current = true;
    if (selectingProject) {
      const url = new URL(window.location.href);
      url.searchParams.delete("integration");
      url.searchParams.delete("status");
      url.searchParams.delete("selection_state");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setProjects([]);
    setProjectId("");
    setStep(null);
    setSetupState(null);
    setError(null);
    setIsSubmitting(false);
    onCancel();
  }, [onCancel, selectingProject]);

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

  async function runSetup(state: string) {
    const deadline = Date.now() + SETUP_TIMEOUT_MS;
    while (!cancelled.current) {
      const progress = await postJson<
        | { status: "connected"; redirectUrl: string }
        | { status: "pending"; step: GcpSetupStep }
      >(gcpEndpoint(connectUrl, "setup"), { setupState: state });
      if (progress.status === "connected") {
        window.location.assign(progress.redirectUrl);
        return;
      }
      setStep(progress.step);
      if (Date.now() > deadline) {
        throw new Error(
          "Google is still applying the new access. Wait a few minutes, then connect the project again.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, SETUP_POLL_INTERVAL_MS));
    }
  }

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
    if (!projectId) return;
    cancelled.current = false;
    setIsSubmitting(true);
    try {
      let state = setupState;
      if (!state) {
        state = (await postJson<{ setupState: string }>(
          gcpEndpoint(connectUrl, "select-project"),
          { projectId, selectionState },
        )).setupState;
        setSetupState(state);
      }
      await runSetup(state);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Google Cloud setup failed. Try again.",
      );
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
            {selectingProject ? "Choose a project" : "Add a GCP project"}
          </h2>
          <p>
            Responder receives short-lived, read-only tokens. No service-account
            keys are created or stored.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          {selectingProject ? (
            <>
              <label className="siteDialog__field">
                <span>Google Cloud project</span>
                <select
                  autoFocus
                  disabled={loadingProjects || isSubmitting || Boolean(setupState)}
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
              <p className="siteDialog__oauthNote" aria-live="polite">
                {loadingProjects
                  ? "Loading projects from your Google account…"
                  : step
                    ? SETUP_STEP_LABELS[step]
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
              Cancel
            </button>
            <button
              className="button button--primary button--small"
              disabled={isSubmitting || loadingProjects || (selectingProject && !projectId)}
              type="submit"
            >
              {isSubmitting ? (
                <><span aria-hidden="true" className="buttonSpinner" />{selectingProject ? "Setting up…" : "Redirecting…"}</>
              ) : selectingProject ? (
                error && setupState ? "Try again" : "Grant read-only access"
              ) : (
                "Continue with Google"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
