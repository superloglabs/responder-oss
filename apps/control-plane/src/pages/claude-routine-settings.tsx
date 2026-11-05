import { type FormEvent, useEffect, useRef, useState } from "react";
import { AppShell } from "../components/app-shell";
import { MemberListSkeleton } from "../components/screen-skeletons";
import { SettingsHeading } from "../components/settings-heading";
import {
  claudeRoutineStatus,
  createClaudeRoutine,
  deleteClaudeRoutine,
  fetchClaudeRoutines,
  testClaudeRoutine,
  type ClaudeRoutine,
} from "../claude-routines-api";
import { useDocumentTitle } from "../use-document-title";

const routinesUrl = "https://claude.ai/code/routines";
const docsUrl = "https://code.claude.com/docs/en/routines#add-an-api-trigger";

export function ClaudeRoutineSettingsPage() {
  useDocumentTitle("Claude routines");
  // Undefined while loading; null when this workspace cannot use routines.
  const [routines, setRoutines] = useState<ClaudeRoutine[] | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [fireUrl, setFireUrl] = useState("");
  const [token, setToken] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ sessionUrl?: string; text: string } | null>(null);
  // Only the newest list may be shown; older responses are dropped.
  const loadGeneration = useRef(0);

  async function reload() {
    const generation = ++loadGeneration.current;
    const loaded = await fetchClaudeRoutines();
    if (generation === loadGeneration.current) setRoutines(loaded);
  }

  useEffect(() => {
    reload().catch((cause: unknown) => {
      setRoutines([]);
      setError(cause instanceof Error ? cause.message : "Unable to load Claude routines");
    });
  }, []);

  async function run(id: string, action: () => Promise<{ sessionUrl?: string; text: string } | null>) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
      await reload().catch(() => undefined);
    } finally {
      setBusyId(null);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("new", async () => {
      const routine = await createClaudeRoutine({ fireUrl: fireUrl.trim(), name: name.trim(), token: token.trim() });
      setName("");
      setFireUrl("");
      setToken("");
      return { text: `${routine.name} added. Choose it in an alert or in error notifications.` };
    });
  }

  function test(routine: ClaudeRoutine) {
    void run(routine.id, async () => {
      const sessionUrl = await testClaudeRoutine(routine.id);
      return { sessionUrl: sessionUrl ?? undefined, text: `${routine.name} started a test session.` };
    });
  }

  function remove(routine: ClaudeRoutine) {
    if (!window.confirm(`Remove ${routine.name}? Alerts and error notifications that start it stop starting it.`)) return;
    void run(routine.id, async () => {
      await deleteClaudeRoutine(routine.id);
      return { text: `${routine.name} removed.` };
    });
  }

  return (
    <AppShell active="settings" density="settings" redesigned>
      <SettingsHeading active="claude-routines" />

      <section className="workspaceSettings">
        <p className="memberAccessNote">
          Alerts and error notifications can start a <a href={docsUrl} rel="noreferrer" target="_blank">Claude Code routine</a> with
          the alert or error as its context. In <a href={routinesUrl} rel="noreferrer" target="_blank">claude.ai/code/routines</a>,
          add an API trigger to the routine, then paste its Fire URL and token here. Write the routine&apos;s prompt to act on
          the text it is started with. Each start uses the routine owner&apos;s Claude plan, and a routine accepts 30 starts an hour.
        </p>

        {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
        {notice ? (
          <p className="settingsNotice settingsNotice--success">
            {notice.text}
            {notice.sessionUrl ? <> <a href={notice.sessionUrl} rel="noreferrer" target="_blank">Open the session</a></> : null}
          </p>
        ) : null}

        {routines === null ? null : (
          <form className="inviteForm" onSubmit={add}>
            <div>
              <h3>Add a routine</h3>
              <p>Owners and admins can add routines. The token is stored encrypted and is not shown again.</p>
            </div>
            <div className="inviteForm__controls">
              <input
                aria-label="Routine name"
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name, such as Triage alerts"
                required
                value={name}
              />
            </div>
            <div className="inviteForm__controls">
              <input
                aria-label="Fire URL"
                maxLength={500}
                onChange={(event) => setFireUrl(event.target.value)}
                placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire"
                required
                type="url"
                value={fireUrl}
              />
            </div>
            <div className="inviteForm__controls">
              <input
                aria-label="Token"
                autoComplete="off"
                maxLength={1_000}
                onChange={(event) => setToken(event.target.value)}
                placeholder="sk-ant-oat01-…"
                required
                type="password"
                value={token}
              />
              <button className="button button--primary" disabled={busyId === "new"} type="submit">
                {busyId === "new" ? "Adding…" : "Add"}
              </button>
            </div>
          </form>
        )}

        <div className="memberSection">
          <div className="memberSection__heading">
            <h3>Claude routines</h3>
            <span>{routines?.length ?? 0}</span>
          </div>
          {routines === undefined ? <MemberListSkeleton /> : routines === null ? (
            <p className="settingsEmpty">Claude routines start from alerts and errors, which this workspace does not have yet.</p>
          ) : routines.length === 0 ? (
            <p className="settingsEmpty">No routines yet.</p>
          ) : (
            <div className="memberList">
              {routines.map((routine) => (
                <div className="memberRow" key={routine.id}>
                  <div className="memberIdentity">
                    <strong>{routine.name}</strong>
                    <span><code>{routine.triggerId}</code> · {claudeRoutineStatus(routine)}</span>
                  </div>
                  <div className="invitationActions">
                    <button
                      className="memberAction"
                      disabled={busyId === routine.id}
                      onClick={() => test(routine)}
                      type="button"
                    >
                      Send test
                    </button>
                    <button
                      className="memberAction memberAction--danger"
                      disabled={busyId === routine.id}
                      onClick={() => remove(routine)}
                      type="button"
                    >
                      Remove
                    </button>
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
