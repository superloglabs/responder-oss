import { useCallback, useEffect, useState, type FormEvent } from "react";

type SupabaseAccessMode = "logs" | "read_only" | "read_write";

interface SupabaseProject {
  name: string;
  organizationId: string;
  organizationSlug: string;
  ref: string;
}

const ACCESS_MODES: Array<{
  description: string;
  label: string;
  value: SupabaseAccessMode;
}> = [
  {
    description: "Project logs, with no database tools.",
    label: "Logs only",
    value: "logs",
  },
  {
    description: "Logs, schema metadata, and read-only SQL.",
    label: "Logs and read-only data",
    value: "read_only",
  },
  {
    description: "Logs and arbitrary database SQL, including data writes.",
    label: "Full database SQL access",
    value: "read_write",
  },
];

function supabaseEndpoint(connectUrl: string, endpoint: string): string {
  const parts = connectUrl.split("/");
  parts.pop();
  return `${parts.join("/")}/${endpoint}`;
}

export function SupabaseConnectionDialog({
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
  const [projects, setProjects] = useState<SupabaseProject[]>([]);
  const [projectRef, setProjectRef] = useState("");
  const [accessMode, setAccessMode] = useState<SupabaseAccessMode>("logs");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setProjects([]);
    setProjectRef("");
    setAccessMode("logs");
    setError(null);
    setIsSubmitting(false);
    onCancel();
  }, [onCancel]);

  useEffect(() => {
    if (!open || !selectionState) return;
    let cancelled = false;
    const projectsUrl = new URL(
      supabaseEndpoint(connectUrl, "projects"),
      window.location.origin,
    );
    projectsUrl.searchParams.set("state", selectionState);
    void fetch(`${projectsUrl.pathname}${projectsUrl.search}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | {
              accessMode?: SupabaseAccessMode;
              error?: string;
              projects?: SupabaseProject[];
            }
          | null;
        if (!response.ok || !body?.projects || !body.accessMode) {
          throw new Error(body?.error ?? "Unable to load Supabase projects");
        }
        if (cancelled) return;
        setAccessMode(body.accessMode);
        setProjects(body.projects);
        setProjectRef(body.projects[0]?.ref ?? "");
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to load Supabase projects",
          );
        }
      });
    return () => {
      cancelled = true;
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
    if (isSubmitting || (selectingProject && projects.length === 0)) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(
        selectingProject
          ? supabaseEndpoint(connectUrl, "select-project")
          : connectUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            selectingProject
              ? { projectRef, selectionState }
              : { accessMode, returnTo },
          ),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to connect Supabase");
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to connect Supabase",
      );
      setIsSubmitting(false);
    }
  }

  if (!open) return null;

  const selectedMode = ACCESS_MODES.find((mode) => mode.value === accessMode)!;
  const loadingProjects = selectingProject && projects.length === 0 && !error;

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) cancel();
      }}
    >
      <section
        aria-labelledby="supabase-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect Supabase</span>
          <h2 id="supabase-connection-title">
            {selectingProject ? "Choose a project" : "Add project context"}
          </h2>
          <p>
            {selectingProject
              ? "Select the project Responder may use during investigations."
              : "Choose the maximum access its investigation tools may use."}
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          {selectingProject ? (
            <>
              <label className="siteDialog__field">
                <span>Supabase project</span>
                <select
                  autoFocus
                  disabled={loadingProjects || isSubmitting}
                  onChange={(event) => {
                    setProjectRef(event.target.value);
                    setError(null);
                  }}
                  value={projectRef}
                >
                  {projects.map((project) => (
                    <option key={project.ref} value={project.ref}>
                      {project.name} — {project.ref}
                    </option>
                  ))}
                </select>
              </label>
              <p className="siteDialog__oauthNote">
                {loadingProjects
                  ? "Loading projects from the authorized organization…"
                  : `${selectedMode.label}: ${selectedMode.description}`}
              </p>
            </>
          ) : (
            <>
              <label className="siteDialog__field">
                <span>Agent access</span>
                <select
                  autoFocus
                  disabled={isSubmitting}
                  onChange={(event) => {
                    setAccessMode(event.target.value as SupabaseAccessMode);
                    setError(null);
                  }}
                  value={accessMode}
                >
                  {ACCESS_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>{mode.label}</option>
                  ))}
                </select>
              </label>
              <p className="siteDialog__oauthNote">{selectedMode.description}</p>
            </>
          )}
          {accessMode === "read_write" ? (
            <p className="siteDialog__error" role="note">
              This allows an agent to change production data and schema with
              raw SQL. Dedicated migration and Supabase administration tools
              remain blocked.
            </p>
          ) : null}
          {!selectingProject ? (
            <p className="siteDialog__oauthNote">
              You’ll continue to Supabase, choose an organization, and authorize
              Responder. We’ll load its projects after authorization.
            </p>
          ) : null}
          <p className="siteDialog__oauthNote">
            Supabase recommends its MCP server for development and testing. If
            you connect production, prefer the lowest access level that works.
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
                loadingProjects ||
                (selectingProject && !projectRef)
              }
              type="submit"
            >
              {isSubmitting ? (
                <><span aria-hidden="true" className="buttonSpinner" />Connecting…</>
              ) : selectingProject ? (
                "Connect project"
              ) : (
                "Continue with Supabase"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
