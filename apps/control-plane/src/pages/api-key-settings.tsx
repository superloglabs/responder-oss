import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  apiKeyUsage,
  createApiKey,
  fetchApiKeys,
  revokeApiKey,
  type WorkspaceApiKey,
} from "../api-keys-api";
import { AppShell } from "../components/app-shell";
import { SettingsHeading } from "../components/settings-heading";
import { MemberListSkeleton } from "../components/screen-skeletons";
import { useDocumentTitle } from "../use-document-title";

const docsUrl = "https://docs.superlog.sh/api-reference/introduction";

export function ApiKeySettingsPage() {
  useDocumentTitle("API keys");
  const [keys, setKeys] = useState<WorkspaceApiKey[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Only the newest list may be shown; older responses are dropped.
  const loadGeneration = useRef(0);

  async function reload() {
    const generation = ++loadGeneration.current;
    const loaded = await fetchApiKeys();
    if (generation === loadGeneration.current) setKeys(loaded);
  }

  useEffect(() => {
    reload().catch((cause: unknown) => {
      setKeys([]);
      setError(cause instanceof Error ? cause.message : "Unable to load API keys");
    });
  }, []);

  async function run(id: string, action: () => Promise<string | null>) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
    } finally {
      setBusyId(null);
    }
  }

  function addKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("new", async () => {
      const result = await createApiKey(name.trim());
      setCreated(result.token);
      setName("");
      return null;
    });
  }

  function remove(key: WorkspaceApiKey) {
    if (!window.confirm(`Revoke ${key.name}? Anything using it stops working.`)) return;
    void run(key.id, async () => {
      await revokeApiKey(key.id);
      return `${key.name} revoked.`;
    });
  }

  async function copyCreated(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setNotice("API key copied.");
    } catch {
      setError("Unable to copy. Select the key and copy it manually.");
    }
  }

  return (
    <AppShell active="settings" density="settings" redesigned>
      <SettingsHeading active="api-keys" />

      <section className="workspaceSettings">
        <p className="memberAccessNote">
          API keys give the <a href={docsUrl} rel="noreferrer" target="_blank">management API</a> and
          the Superlog MCP server access to this workspace&apos;s automations,
          runs, tag mode, model access, and secrets. A key acts as the member
          who created it and stops working if they leave the workspace.
        </p>

        {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
        {notice ? <p className="settingsNotice settingsNotice--success">{notice}</p> : null}

        <form className="inviteForm" onSubmit={addKey}>
          <div>
            <h3>Create an API key</h3>
            <p>You can see the key only once, right after you create it.</p>
          </div>
          <div className="inviteForm__controls">
            <input
              aria-label="Key name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name, such as Claude Code or CI"
              required
              value={name}
            />
            <button className="button button--primary" disabled={busyId === "new"} type="submit">
              {busyId === "new" ? "Creating…" : "Create key"}
            </button>
          </div>
          {created ? (
            <div className="invitationLink">
              <input aria-label="New API key" readOnly value={created} />
              <button className="button button--secondary" onClick={() => void copyCreated(created)} type="button">
                Copy key
              </button>
            </div>
          ) : null}
        </form>

        <div className="memberSection">
          <div className="memberSection__heading">
            <h3>API keys</h3>
            <span>{keys?.length ?? 0}</span>
          </div>
          {keys === null ? <MemberListSkeleton /> : keys.length === 0 ? (
            <p className="settingsEmpty">No API keys yet.</p>
          ) : (
            <div className="memberList">
              {keys.map((key) => (
                <div className="memberRow" key={key.id}>
                  <div className="memberIdentity">
                    <strong>{key.name}</strong>
                    <span><code>{key.prefix}…</code> · {apiKeyUsage(key)}</span>
                  </div>
                  <div className="invitationActions">
                    {key.canRevoke ? (
                      <button
                        className="memberAction memberAction--danger"
                        disabled={busyId === key.id}
                        onClick={() => remove(key)}
                        type="button"
                      >
                        Revoke
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </AppShell>
  );
}
