import { FloppyDiskIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { AutomationEditorSkeleton } from "../components/screen-skeletons";
import { SelectField, TextField } from "../design-system";
import { deleteMemory, fetchMemory, saveMemory, type MemoryInput, type MemoryType } from "../memories-api";
import { useDocumentTitle } from "../use-document-title";
import {
  memoryBodyMaxLength,
  memoryCredentialKinds,
  memoryDescriptionMaxLength,
  memoryNameMaxLength,
} from "../../../../packages/core/src/memories/config";
import "./automation-create.css";
import "./memories.css";

const emptyMemory: MemoryInput = { name: "", description: "", type: "project", body: "" };

const typeOptions: Array<{ description: string; label: string; value: MemoryType }> = [
  { description: "How the systems are set up, ongoing work, and past incidents.", label: "Project", value: "project" },
  { description: "Where to find something, such as a dashboard or a runbook.", label: "Reference", value: "reference" },
  { description: "How agents should work in this workspace.", label: "Feedback", value: "feedback" },
  { description: "Facts about the people on the team.", label: "User", value: "user" },
];

export function MemoryEditorPage() {
  const { memoryId } = useParams();
  const navigate = useNavigate();
  const [memory, setMemory] = useState<MemoryInput>(emptyMemory);
  const [savedName, setSavedName] = useState("");
  const [lastSaved, setLastSaved] = useState<{ at: string; by: string | null } | null>(null);
  // The memory the form holds. A memory this page just created is not read
  // again, so nothing overwrites edits made after saving.
  const [loadedMemoryId, setLoadedMemoryId] = useState<string | undefined>(undefined);
  const loadedMemoryIdRef = useRef<string | undefined>(undefined);
  // A memory that failed to load is not shown, so saving cannot replace it
  // with an empty form.
  const [failedMemoryId, setFailedMemoryId] = useState<string | undefined>(undefined);
  const loadFailed = Boolean(memoryId) && failedMemoryId === memoryId;
  const loading = Boolean(memoryId) && loadedMemoryId !== memoryId && !loadFailed;
  // Counts edits, so a save that finishes after more edits does not mark
  // them saved.
  const edits = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle(savedName ? `${savedName} · Memory` : "New memory");

  useEffect(() => {
    let cancelled = false;
    if (!memoryId) {
      // Opening a new memory from an existing one starts from an empty form.
      if (loadedMemoryIdRef.current !== undefined) {
        loadedMemoryIdRef.current = undefined;
        setLoadedMemoryId(undefined);
        setMemory(emptyMemory);
        setSavedName("");
        setLastSaved(null);
        setSaved(false);
        setError(null);
      }
    } else if (loadedMemoryIdRef.current !== memoryId) {
      setError(null);
      void fetchMemory(memoryId)
        .then((loaded) => {
          if (cancelled) return;
          setMemory({ body: loaded.body, description: loaded.description, name: loaded.name, type: loaded.type });
          setSavedName(loaded.name);
          setLastSaved({ at: loaded.updatedAt, by: loaded.updatedBy?.name ?? null });
          setSaved(false);
          loadedMemoryIdRef.current = memoryId;
          setLoadedMemoryId(memoryId);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(cause instanceof Error ? cause.message : "Unable to load the memory");
          setFailedMemoryId(memoryId);
        });
    }
    return () => { cancelled = true; };
  }, [memoryId]);

  function update(patch: Partial<MemoryInput>) {
    edits.current += 1;
    setMemory((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const editsAtSave = edits.current;
    try {
      const id = await saveMemory(memoryId, memory);
      setSavedName(memory.name);
      setSaved(edits.current === editsAtSave);
      setLastSaved({ at: new Date().toISOString(), by: null });
      if (!memoryId) {
        loadedMemoryIdRef.current = id;
        setLoadedMemoryId(id);
        navigate(`/memory/${id}`, { replace: true });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the memory");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!memoryId || !window.confirm(`Delete ${savedName}? Runs that start afterward no longer read it.`)) return;
    setError(null);
    try {
      await deleteMemory(memoryId);
      navigate("/memory");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete the memory");
    }
  }

  const credentials = memoryCredentialKinds(memory);

  return (
    <AppShell active="memory" redesigned density="create">
      <div className="automationCreate">
        <header className="automationCreate__header">
          <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb"><Link to="/memory">Memory</Link><span aria-hidden="true">›</span><span>{memoryId ? savedName : "New memory"}</span></nav>
          <div className="automationCreate__titleRow">
            <h1>{memoryId ? savedName : "New memory"}</h1>
            <span className="automationCreate__spacer" />
            {saved ? <span aria-live="polite" className="automationCreate__saveStatus">Saved</span> : null}
            {memoryId ? <button className="automationCreate__secondary" disabled={loading || loadFailed} onClick={() => void remove()} type="button"><TrashIcon size={14} />Delete</button> : null}
            <button className="automationCreate__save" disabled={saving || loading || loadFailed} form="memory-settings" type="submit"><FloppyDiskIcon size={14} />{saving ? "Saving…" : "Save"}</button>
          </div>
        </header>
        {error ? <p className="formError" role="alert">{error}</p> : null}
        {credentials.length > 0 ? <p className="automationCreate__unsaved" role="alert">This memory seems to contain {credentials.join(", ")}. Every run in the workspace reads memories, so they cannot hold credentials. Say where the secret is kept instead.</p> : null}
        {loadFailed ? null : loading ? <AutomationEditorSkeleton /> : <form className="automationCreate__form" id="memory-settings" onSubmit={(event) => void submit(event)}>
          <section className="automationCreate__section automationCreate__section--trigger" aria-labelledby="memory-details">
            <h2 id="memory-details">Details</h2>
            <div className="memoryEditor__fields">
              <TextField autoComplete="off" hint="Lowercase letters, numbers, and hyphens." label="Name" maxLength={memoryNameMaxLength} onChange={(event) => update({ name: event.target.value.toLowerCase() })} placeholder="prod-database-failover" required value={memory.name} />
              <SelectField<MemoryType> hint={typeOptions.find((option) => option.value === memory.type)?.description} label="Type" onChange={(type) => update({ type })} options={typeOptions} value={memory.type} />
            </div>
            <TextField autoComplete="off" hint="One line. Agents choose which memories to read from it." label="Description" maxLength={memoryDescriptionMaxLength} onChange={(event) => update({ description: event.target.value.replace(/\n/gu, " ") })} placeholder="What to check when the EU database fails over" required value={memory.description} />
          </section>
          <section className="automationCreate__section" aria-labelledby="memory-body">
            <h2 id="memory-body">Memory</h2>
            <div className="automationCreate__instructions">
              <textarea aria-labelledby="memory-body" maxLength={memoryBodyMaxLength} onChange={(event) => update({ body: event.target.value })} placeholder={"What happened, what is true now, and how to apply it.\n\nLink related memories with [[their-name]]."} required value={memory.body} />
              <div className="automationCreate__toolbar memoryEditor__hint">
                Runs read this as .responder/memory/{memory.name || "<name>"}.md, in Claude Code&apos;s memory format.
                {lastSaved ? ` Last saved ${relativeTime(lastSaved.at)}${lastSaved.by ? ` by ${lastSaved.by}` : ""}.` : null}
              </div>
            </div>
          </section>
        </form>}
      </div>
    </AppShell>
  );
}
