import { useCallback, useEffect, useState, type FormEvent } from "react";

type SupabaseAccessMode = "logs" | "read_only" | "read_write";

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

export function SupabaseConnectionDialog({
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
  const [projectRef, setProjectRef] = useState("");
  const [accessMode, setAccessMode] = useState<SupabaseAccessMode>("logs");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    setProjectRef("");
    setAccessMode("logs");
    setError(null);
    setIsSubmitting(false);
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
        body: JSON.stringify({ accessMode, projectRef, returnTo }),
      });
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

  const validProjectRef = /^[a-z0-9]{20}$/u.test(projectRef.trim());
  const selectedMode = ACCESS_MODES.find((mode) => mode.value === accessMode)!;

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
          <h2 id="supabase-connection-title">Add project context</h2>
          <p>
            Choose one project and the maximum access its investigation tools
            may use.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={connect}>
          <label className="siteDialog__field">
            <span>Project ID</span>
            <input
              autoFocus
              disabled={isSubmitting}
              maxLength={20}
              minLength={20}
              onChange={(event) => {
                setProjectRef(event.target.value.trim().toLowerCase());
                setError(null);
              }}
              pattern="[a-z0-9]{20}"
              placeholder="abcdefghijklmnopqrst"
              required
              spellCheck={false}
              value={projectRef}
            />
          </label>
          <p className="siteDialog__oauthNote">
            Find this in the Supabase dashboard URL or under Project Settings.
          </p>

          <label className="siteDialog__field">
            <span>Agent access</span>
            <select
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
          {accessMode === "read_write" ? (
            <p className="siteDialog__error" role="note">
              This allows an agent to change production data and schema with
              raw SQL. Dedicated migration and Supabase administration tools
              remain blocked.
            </p>
          ) : null}
          <p className="siteDialog__oauthNote">
            You’ll continue to Supabase to authorize the selected project.
            Responder also filters the available tools to this access level.
          </p>
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
              disabled={isSubmitting || !validProjectRef}
              type="submit"
            >
              {isSubmitting ? (
                <><span aria-hidden="true" className="buttonSpinner" />Authorizing…</>
              ) : "Continue with Supabase"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
