import { CheckIcon, FileTextIcon, FloppyDiskIcon, FolderOpenIcon, KeyIcon, PlusIcon, TrashIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { createWorkspaceSecret } from "../agents-api";
import { fetchAutomationOptions } from "../automations-api";
import { AppShell } from "../components/app-shell";
import { AutomationEditorDialog } from "../components/automation-editor-dialog";
import { AutomationEditorSkeleton } from "../components/screen-skeletons";
import { searchInputProps } from "../components/search-input-props";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { TextField } from "../design-system";
import { deleteSkill, fetchSkill, saveSkill, type SkillInput, type SkillSecret } from "../skills-api";
import { folderRelativePath, formatFileSize, likelyCredentialSources, mergeSkillFiles, readSkillFolder, type UploadedSkillFile } from "../skill-folder";
import { useDocumentTitle } from "../use-document-title";
import { skillNameSchema } from "../../../../packages/core/src/skills/config";
import "./automation-create.css";
import "./skills.css";

const emptySkill: SkillInput = { name: "", description: "", instructions: "", files: [], secretIds: [] };

// A SKILL.md name that is not a valid skill name, such as "Billing API",
// becomes one: "billing-api".
function skillNameFrom(value: string): string {
  const parsed = skillNameSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64).replace(/-+$/u, "");
}

async function uploadedFiles(list: FileList, folder: boolean): Promise<UploadedSkillFile[]> {
  return Promise.all([...list].map(async (file) => ({
    bytes: new Uint8Array(await file.arrayBuffer()),
    path: folder ? folderRelativePath(file.webkitRelativePath) : file.name,
  })));
}

function SecretPicker({ secrets, selectedIds, onToggle, onCreate }: {
  secrets: SkillSecret[] | null;
  selectedIds: string[];
  onToggle: (secretId: string) => void;
  onCreate: () => void;
}) {
  return <Popover>
    <PopoverTrigger asChild><button className="automationCreate__add" disabled={!secrets} type="button"><PlusIcon size={16} />Add secret</button></PopoverTrigger>
    <PopoverContent align="start" className="w-80 p-0">
      <Command>
        <CommandInput {...searchInputProps} placeholder="Search secrets…" className="h-9" />
        <CommandList>
          <CommandEmpty>No secrets found.</CommandEmpty>
          {secrets?.length ? <CommandGroup heading="Workspace secrets">
            {secrets.map((secret) => <CommandItem key={secret.id} value={secret.id} keywords={[secret.name, ...secret.allowedHosts]} onSelect={() => onToggle(secret.id)}>
              <KeyIcon />
              <span className="truncate">{secret.name}</span>
              <CheckIcon className={cn("ml-auto", selectedIds.includes(secret.id) ? "opacity-100" : "opacity-0")} />
            </CommandItem>)}
          </CommandGroup> : null}
          <CommandGroup>
            <CommandItem value="create-secret" keywords={["create", "new"]} onSelect={onCreate}><PlusIcon />Create a secret</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}

function CreateSecretDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (secret: SkillSecret) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const allowedHosts = [...new Set(hosts.split(/[\s,]+/u).map((host) => host.trim().toLowerCase()).filter(Boolean))];
    if (!name.trim() || !value || allowedHosts.length === 0) {
      setError("Add a name, value, and at least one allowed host.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onCreated(await createWorkspaceSecret({ allowedHosts, name: name.trim().toUpperCase(), value }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to store the secret");
      setSaving(false);
    }
  }

  return <AutomationEditorDialog
    actions={<button className="automationCreate__save" disabled={saving} onClick={() => void create()} type="button">{saving ? "Storing…" : "Store and add"}</button>}
    onClose={onClose}
    title="Create a secret"
  >
    <TextField autoComplete="off" autoFocus label="Environment variable" onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="BILLING_API_KEY" value={name} />
    <TextField autoComplete="new-password" label="Secret value" onChange={(event) => setValue(event.target.value)} placeholder="Stored once and never shown again" type="password" value={value} />
    <TextField autoComplete="off" hint="The agent can send the secret only to these hosts." label="Allowed hosts" onChange={(event) => setHosts(event.target.value)} placeholder="api.example.com, *.example.net" value={hosts} />
    {error ? <p className="formError" role="alert">{error}</p> : null}
  </AutomationEditorDialog>;
}

export function SkillEditorPage() {
  const { skillId } = useParams();
  const navigate = useNavigate();
  const [skill, setSkill] = useState<SkillInput>(emptySkill);
  const [savedName, setSavedName] = useState("");
  const [usedBy, setUsedBy] = useState<Array<{ id: string; name: string }>>([]);
  const [knownSecrets, setKnownSecrets] = useState<SkillSecret[]>([]);
  const [workspaceSecrets, setWorkspaceSecrets] = useState<SkillSecret[] | null>(null);
  // The skill the form holds. A skill this page just created is not read
  // again, so nothing overwrites edits made after saving.
  const [loadedSkillId, setLoadedSkillId] = useState<string | undefined>(undefined);
  const loadedSkillIdRef = useRef<string | undefined>(undefined);
  const loading = Boolean(skillId) && loadedSkillId !== skillId;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingSecret, setCreatingSecret] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  useDocumentTitle(savedName ? `${savedName} · Skills` : "New skill");

  useEffect(() => {
    let cancelled = false;
    void fetchAutomationOptions()
      .then((options) => { if (!cancelled) setWorkspaceSecrets(options.secrets); })
      .catch(() => { if (!cancelled) setWorkspaceSecrets([]); });
    if (skillId && loadedSkillIdRef.current !== skillId) {
      void fetchSkill(skillId)
        .then((loaded) => {
          if (cancelled) return;
          setSkill({
            description: loaded.description,
            files: loaded.files,
            instructions: loaded.instructions,
            name: loaded.name,
            secretIds: loaded.secrets.map((secret) => secret.id),
          });
          setKnownSecrets(loaded.secrets);
          setSavedName(loaded.name);
          setUsedBy(loaded.automations);
        })
        .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load the skill"); })
        .finally(() => {
          if (cancelled) return;
          loadedSkillIdRef.current = skillId;
          setLoadedSkillId(skillId);
        });
    }
    return () => { cancelled = true; };
  }, [skillId]);

  function update(patch: Partial<SkillInput>) {
    setSkill((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function addUploaded(event: ChangeEvent<HTMLInputElement>, folder: boolean) {
    const list = event.target.files;
    if (!list?.length) return;
    try {
      const read = readSkillFolder(await uploadedFiles(list, folder));
      const merged = mergeSkillFiles(skill.files, read.files);
      setSkill((current) => ({
        ...current,
        ...(read.skill?.name ? { name: skillNameFrom(read.skill.name) } : {}),
        ...(read.skill?.description ? { description: read.skill.description } : {}),
        ...(read.skill?.instructions ? { instructions: read.skill.instructions } : {}),
        files: merged.files,
      }));
      setSaved(false);
      const skipped = [...read.skipped, ...merged.skipped];
      setNotice(skipped.length > 0
        ? `Skipped ${skipped.map((file) => `${file.path} (${file.reason})`).join(", ")}.`
        : null);
    } catch {
      setError("Unable to read the uploaded files");
    } finally {
      event.target.value = "";
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const id = await saveSkill(skillId, skill);
      setSavedName(skill.name);
      setSaved(true);
      if (!skillId) {
        loadedSkillIdRef.current = id;
        setLoadedSkillId(id);
        navigate(`/skills/${id}`, { replace: true });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the skill");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!skillId || !window.confirm(`Delete ${savedName}? Automations can no longer use it.`)) return;
    setError(null);
    try {
      await deleteSkill(skillId);
      navigate("/skills");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete the skill");
    }
  }

  const secretsById = new Map([...knownSecrets, ...(workspaceSecrets ?? [])].map((secret) => [secret.id, secret]));
  const selectedSecrets = skill.secretIds.flatMap((id) => secretsById.get(id) ?? []);
  const folderPath = `.responder/skills/${skill.name || "<name>"}`;
  const credentialSources = likelyCredentialSources([
    { name: "The instructions", content: skill.instructions },
    ...skill.files.map((file) => ({ name: file.path, content: file.content })),
  ]);

  return (
    <AppShell active="skills" redesigned density="create">
      <div className="automationCreate">
        <header className="automationCreate__header">
          <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb"><Link to="/skills">Skills</Link><span aria-hidden="true">›</span><span>{skillId ? savedName : "Create skill"}</span></nav>
          <div className="automationCreate__titleRow">
            <h1>{skillId ? savedName : "New skill"}</h1>
            <span className="automationCreate__spacer" />
            {saved ? <span aria-live="polite" className="automationCreate__saveStatus">Saved</span> : null}
            <button className="automationCreate__secondary" disabled={loading} onClick={() => folderInput.current?.click()} title="Upload a folder with a SKILL.md and its files" type="button"><FolderOpenIcon size={14} />Upload folder</button>
            {skillId ? <button className="automationCreate__secondary" disabled={loading} onClick={() => void remove()} type="button"><TrashIcon size={14} />Delete</button> : null}
            <button className="automationCreate__save" disabled={saving || loading} form="skill-settings" type="submit"><FloppyDiskIcon size={14} />{saving ? "Saving…" : "Save"}</button>
          </div>
        </header>
        <input className="skillEditor__fileInput" multiple onChange={(event) => void addUploaded(event, true)} ref={(element) => { folderInput.current = element; element?.setAttribute("webkitdirectory", ""); }} tabIndex={-1} type="file" />
        <input className="skillEditor__fileInput" multiple onChange={(event) => void addUploaded(event, false)} ref={fileInput} tabIndex={-1} type="file" />
        {error ? <p className="formError" role="alert">{error}</p> : null}
        {notice ? <p className="automationCreate__unsaved" role="status">{notice}</p> : null}
        {credentialSources.length > 0 ? <p className="automationCreate__unsaved" role="alert">{credentialSources.join(", ")} may contain a credential. Skill text is stored as written and the agent can read it. Store keys as secrets instead.</p> : null}
        {loading ? <AutomationEditorSkeleton /> : <form className="automationCreate__form" id="skill-settings" onSubmit={(event) => void submit(event)}>
          <section className="automationCreate__section automationCreate__section--trigger" aria-labelledby="skill-details">
            <h2 id="skill-details">Details</h2>
            <div className="skillEditor__fields">
              <TextField autoComplete="off" hint="Lowercase letters, numbers, and hyphens." label="Name" maxLength={64} onChange={(event) => update({ name: event.target.value.toLowerCase() })} placeholder="billing-api" required value={skill.name} />
              <TextField autoComplete="off" hint="Tells the agent when to use this skill." label="Description" maxLength={1_024} onChange={(event) => update({ description: event.target.value })} placeholder="Look up customer invoices and refunds in the billing API." required value={skill.description} />
            </div>
          </section>
          <section className="automationCreate__section" aria-labelledby="skill-instructions">
            <h2 id="skill-instructions">Instructions</h2>
            <div className="automationCreate__instructions">
              <textarea aria-labelledby="skill-instructions" maxLength={100_000} onChange={(event) => update({ instructions: event.target.value })} placeholder={"How to use the API: base URL, authentication, the endpoints that matter, and examples.\n\nAuthenticate with the secret's environment variable, for example:\ncurl -H \"Authorization: Bearer $BILLING_API_KEY\" https://api.billing.example/v1/invoices"} required value={skill.instructions} />
              <div className="automationCreate__toolbar skillEditor__hint">The agent reads this as {folderPath}/SKILL.md in the automation&apos;s sandbox.</div>
            </div>
          </section>
          <section className="automationCreate__section" aria-labelledby="skill-files">
            <h2 id="skill-files">Reference files</h2>
            <div className="automationCreate__rows">
              {skill.files.map((file) => <div className="automationCreate__row" key={file.path}>
                <FileTextIcon size={16} />
                <span>{file.path}</span>
                <small className="skillEditor__meta">{formatFileSize(file.content)}</small>
                <button aria-label={`Remove ${file.path}`} className="automationCreate__iconButton" onClick={() => update({ files: skill.files.filter((candidate) => candidate.path !== file.path) })} type="button"><TrashIcon size={14} /></button>
              </div>)}
              <button className="automationCreate__add" onClick={() => fileInput.current?.click()} type="button"><UploadSimpleIcon size={16} />Add files, such as an OpenAPI spec</button>
            </div>
          </section>
          <section className="automationCreate__section" aria-labelledby="skill-secrets">
            <h2 id="skill-secrets">Secrets</h2>
            <div className="automationCreate__rows">
              {selectedSecrets.map((secret) => <div className="automationCreate__row" key={secret.id}>
                <KeyIcon size={16} />
                <span>{secret.name}</span>
                <small className="skillEditor__meta">{secret.allowedHosts.join(", ")}</small>
                <button aria-label={`Remove ${secret.name}`} className="automationCreate__iconButton" onClick={() => update({ secretIds: skill.secretIds.filter((id) => id !== secret.id) })} type="button"><TrashIcon size={14} /></button>
              </div>)}
              <SecretPicker
                onCreate={() => setCreatingSecret(true)}
                onToggle={(secretId) => update({ secretIds: skill.secretIds.includes(secretId) ? skill.secretIds.filter((id) => id !== secretId) : [...skill.secretIds, secretId] })}
                secrets={workspaceSecrets}
                selectedIds={skill.secretIds}
              />
            </div>
            <p className="skillEditor__hint">Automations that use this skill get these secrets as environment variables. The agent never sees their values, and each one works only for its allowed hosts.</p>
          </section>
          {skillId ? <section className="automationCreate__section" aria-labelledby="skill-automations">
            <h2 id="skill-automations">Used by</h2>
            {usedBy.length > 0 ? <div className="automationCreate__rows">
              {usedBy.map((automation) => <div className="automationCreate__row" key={automation.id}>
                <span>{automation.name}</span>
                <Link className="automationCreate__manage" to={`/automations/${automation.id}/settings`}>Open</Link>
              </div>)}
            </div> : <p className="skillEditor__hint">No automation uses this skill yet. Add it from an automation&apos;s connectors.</p>}
          </section> : null}
        </form>}
      </div>
      {creatingSecret ? <CreateSecretDialog
        onClose={() => setCreatingSecret(false)}
        onCreated={(secret) => {
          setCreatingSecret(false);
          setWorkspaceSecrets((current) => [...(current ?? []), secret].sort((left, right) => left.name.localeCompare(right.name)));
          setSkill((current) => ({ ...current, secretIds: [...current.secretIds, secret.id] }));
          setSaved(false);
        }}
      /> : null}
    </AppShell>
  );
}
