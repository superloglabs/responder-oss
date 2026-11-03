import { useEffect, useState, type FormEvent } from "react";

interface McpTool {
  description?: string;
  name: string;
  readOnly: boolean;
}

type Access = "all" | "selected";

/**
 * Lets a person choose which of a custom MCP server's tools agents may use.
 * Mount it only while it is open, so each opening loads the current tools.
 */
export function CustomMcpToolsDialog({
  accountId,
  displayName,
  onClose,
  onSaved,
}: {
  accountId: string;
  displayName: string;
  onClose: () => void;
  onSaved: (allowedTools: string[] | null) => void;
}) {
  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [access, setAccess] = useState<Access>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/integrations/custom-mcp/${encodeURIComponent(accountId)}/tools`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { allowedTools?: string[] | null; error?: string; tools?: McpTool[] }
          | null;
        if (!response.ok || !body?.tools) {
          throw new Error(body?.error ?? "Unable to list this MCP server's tools");
        }
        if (cancelled) return;
        setTools(body.tools);
        setAccess(body.allowedTools ? "selected" : "all");
        setSelected(new Set(body.allowedTools ?? body.tools.map((tool) => tool.name)));
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setTools([]);
        setError(caught instanceof Error ? caught.message : "Unable to list this MCP server's tools");
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isSaving, onClose]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving) return;
    setError(null);
    setIsSaving(true);
    const allowedTools = access === "all" ? null : [...selected];
    try {
      const response = await fetch(
        `/api/integrations/custom-mcp/${encodeURIComponent(accountId)}/tools`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ allowedTools }),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { allowedTools?: string[] | null; error?: string }
        | null;
      if (!response.ok) throw new Error(body?.error ?? "Unable to save the tools");
      onSaved(body?.allowedTools ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the tools");
    } finally {
      setIsSaving(false);
    }
  }

  function toggle(name: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const readOnlyCount = tools?.filter((tool) => tool.readOnly).length ?? 0;
  // A saved tool the server no longer lists stays in the list until removed.
  const missing = [...selected].filter(
    (name) => tools && !tools.some((tool) => tool.name === name),
  );

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onClose();
      }}
    >
      <section
        aria-labelledby="custom-mcp-tools-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>MCP tools</span>
          <h2 id="custom-mcp-tools-title">{displayName}</h2>
          <p>
            Choose which tools agents can use. Agents do not see the other
            tools, and Responder refuses calls to them.
          </p>
        </header>

        <form className="siteDialog__form" onSubmit={save}>
          <div className="mcpToolAccess" role="radiogroup" aria-label="Tool access">
            <label>
              <input
                checked={access === "all"}
                disabled={isSaving}
                name="mcp-tool-access"
                onChange={() => setAccess("all")}
                type="radio"
              />
              <span>
                <strong>All tools</strong>
                <small>Includes tools the server adds later.</small>
              </span>
            </label>
            <label>
              <input
                checked={access === "selected"}
                disabled={isSaving}
                name="mcp-tool-access"
                onChange={() => setAccess("selected")}
                type="radio"
              />
              <span>
                <strong>Selected tools</strong>
                <small>Tools the server adds later stay off.</small>
              </span>
            </label>
          </div>

          {tools === null ? (
            <p className="mcpToolList__status">
              <span aria-hidden="true" className="buttonSpinner" /> Loading tools…
            </p>
          ) : access === "selected" ? (
            <>
              <div className="mcpToolList__actions">
                <small>
                  {selected.size} of {tools.length + missing.length} selected
                </small>
                <button
                  className="button button--secondary button--small"
                  disabled={isSaving || readOnlyCount === 0}
                  onClick={() =>
                    setSelected(new Set(tools.filter((tool) => tool.readOnly).map((tool) => tool.name)))
                  }
                  title={readOnlyCount === 0 ? "The server marks no tools as read-only" : undefined}
                  type="button"
                >
                  Read-only only
                </button>
                <button
                  className="button button--secondary button--small"
                  disabled={isSaving}
                  onClick={() => setSelected(new Set(tools.map((tool) => tool.name)))}
                  type="button"
                >
                  Select all
                </button>
                <button
                  className="button button--secondary button--small"
                  disabled={isSaving}
                  onClick={() => setSelected(new Set())}
                  type="button"
                >
                  Clear
                </button>
              </div>
              <ul className="mcpToolList" aria-label="Tools">
                {tools.map((tool) => (
                  <li key={tool.name}>
                    <label>
                      <input
                        checked={selected.has(tool.name)}
                        disabled={isSaving}
                        onChange={() => toggle(tool.name)}
                        type="checkbox"
                      />
                      <span>
                        <strong>
                          {tool.name}
                          {tool.readOnly ? <em>Read-only</em> : null}
                        </strong>
                        {tool.description ? <small>{tool.description}</small> : null}
                      </span>
                    </label>
                  </li>
                ))}
                {missing.map((name) => (
                  <li key={name}>
                    <label>
                      <input
                        checked
                        disabled={isSaving}
                        onChange={() => toggle(name)}
                        type="checkbox"
                      />
                      <span>
                        <strong>{name}</strong>
                        <small>The server no longer lists this tool.</small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {readOnlyCount === 0 && tools.length > 0 ? (
                <p className="siteDialog__oauthNote">
                  This server does not mark any tools as read-only. Check each
                  tool's description before you turn it on.
                </p>
              ) : null}
            </>
          ) : null}

          {error ? (
            <p className="siteDialog__error" role="alert">
              {error}
            </p>
          ) : null}

          <footer className="siteDialog__footer">
            <button
              className="button button--secondary button--small"
              disabled={isSaving}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="button button--primary button--small"
              disabled={isSaving || tools === null || (error !== null && tools.length === 0)}
              type="submit"
            >
              {isSaving ? (
                <>
                  <span aria-hidden="true" className="buttonSpinner" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
