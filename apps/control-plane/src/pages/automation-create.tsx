import { type FormEvent, useEffect, useEffectEvent, useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  fetchAutomationOptions,
  runAutomation,
  saveAutomation,
  setAutomationEnabled,
  type AutomationConfiguration,
  type AutomationDetail,
  type AutomationOptions,
  triggerAccountIds,
} from "../automations-api";
import { ChatCircleIcon, FloppyDiskIcon, PencilSimpleIcon, PlayIcon, SquaresFourIcon, TrashIcon, GithubLogoIcon, KeyIcon } from "@phosphor-icons/react";
import { AutomationConnectorPicker } from "../components/automation-connector-picker";
import type { AutomationConnectorProvider } from "../components/automation-connectors";
import { CustomMcpConnectionDialog } from "../components/custom-mcp-dialog";
import { DatadogConnectionDialog } from "../components/datadog-site-dialog";
import { ProviderGlyph } from "../components/icons";
import { providerDisplayName } from "../components/provider-glyphs";
import { restoreAutomationDraft, saveAutomationDraft, takeAutomationDraft, waitForConnectedAccounts } from "./automation-draft";
import { applyAutomationTemplate, automationTemplateMissingFields, findAutomationTemplate } from "./automation-templates";
import { AutomationModelPicker } from "../components/automation-model-picker";
import { AutomationRepositoryPicker } from "../components/automation-repository-picker";
import { AutomationRunHistory } from "../components/automation-run-history";
import { AutomationTriggerEditor } from "../components/automation-trigger-editor";
import { availableAutomationConfiguration, isTriggerComplete, moveItem } from "../automation-configuration";
import { AutomationRepositoryList } from "../components/automation-repository-list";
import "./automation-create.css";
import { AppShell } from "../components/app-shell";
import { Switch } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

const defaultConfiguration: AutomationConfiguration = {
  contextAccountIds: [],
  harness: "codex",
  maxModelRequests: 24,
  maxOutputTokensPerRequest: 16_000,
  maxRuntimeSeconds: 1_800,
  model: "gpt-5.4",
  modelCredentialId: null,
  modelProvider: "openai",
  prompt: "Investigate the event, make the necessary code changes, run focused tests, and open a pull request with a clear summary.",
  repositoryIds: [],
  toolPolicy: "full",
  triggers: [],
  workspaceSecretIds: [],
};

// Returns why the configuration cannot be saved yet, or null when it can.
function incompleteReason(configuration: AutomationConfiguration): { field: "trigger" | "repositories" | "model"; message: string } | null {
  if (!configuration.triggers.length) return { field: "trigger", message: "Add at least one trigger." };
  if (!configuration.triggers.every(isTriggerComplete)) {
    return { field: "trigger", message: "Choose a connection and at least one channel or project for each trigger." };
  }
  if (!configuration.repositoryIds.length) return { field: "repositories", message: "Choose at least one repository." };
  if (!configuration.model.trim()) return { field: "model", message: "Choose a model." };
  return null;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((candidate) => candidate !== value)
    : [...list, value];
}

// Creates an automation, or edits a saved one when `initialAutomation` is set.
// A saved automation also shows its run history.
export function AutomationCreatePage({ initialAutomation }: { initialAutomation?: AutomationDetail } = {}) {
  const automationId = initialAutomation?.id;
  const editorPath = automationId ? `/automations/${automationId}` : "/automations/new";
  const navigate = useNavigate();
  const [options, setOptions] = useState<AutomationOptions | null>(null);
  // A new automation can start from a template chosen on the automation list.
  const [template, setTemplate] = useState(() => automationId ? undefined : findAutomationTemplate(new URLSearchParams(window.location.search).get("template")));
  const [name, setName] = useState(initialAutomation?.name ?? template?.name ?? "New automation");
  const [savedName, setSavedName] = useState(initialAutomation?.name ?? "");
  const description = initialAutomation?.description ?? template?.description ?? "";
  const [enabled, setEnabled] = useState(initialAutomation?.enabled ?? true);
  const [configuration, setConfiguration] = useState<AutomationConfiguration>(initialAutomation?.configuration ?? { ...defaultConfiguration, prompt: "" });
  const [connectDialog, setConnectDialog] = useState<{ provider: "datadog" | "custom_mcp"; connectUrl: string } | null>(null);
  const [triggerMenuOpen, setTriggerMenuOpen] = useState(false);
  const triggerSectionRef = useRef<HTMLElement>(null);
  const [githubIncluded, setGithubIncluded] = useState(initialAutomation ? initialAutomation.configuration.repositoryIds.length > 0 : true);
  const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false);
  const [modelRequestedOpen, setModelRequestedOpen] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [unsavedReason, setUnsavedReason] = useState<string | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  const [runsRefreshKey, setRunsRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<"settings" | "history">("settings");
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle(automationId ? savedName : "New automation");
  // A saved automation saves every change. Handlers read the latest values
  // from these refs because a save can queue before React re-renders.
  const configurationRef = useRef(configuration);
  const nameRef = useRef(name);
  const enabledRef = useRef(enabled);
  const saved = useRef({ configuration, name });
  const queuedSnapshot = useRef(JSON.stringify({ configuration, name }));
  const saveQueue = useRef(Promise.resolve());
  const pendingSaves = useRef(0);
  const latestSave = useRef(0);

  function updateConfiguration(update: (current: AutomationConfiguration) => AutomationConfiguration, persistChange = true) {
    configurationRef.current = update(configurationRef.current);
    setConfiguration(configurationRef.current);
    if (persistChange) persist();
  }

  // Saves run in order so a slow request cannot overwrite a newer one. A failed
  // save restores the last saved settings only when no newer save is queued.
  function enqueue(work: () => Promise<void>) {
    pendingSaves.current += 1;
    setSaveStatus("saving");
    // Work handles its own errors; the catch keeps the queue running if it
    // ever rejects.
    saveQueue.current = saveQueue.current.then(work).catch(() => undefined).finally(() => {
      pendingSaves.current -= 1;
      if (pendingSaves.current === 0) setSaveStatus((status) => status === "saving" ? "saved" : status);
    });
  }

  function persist() {
    if (!automationId) return;
    const next = { configuration: configurationRef.current, name: nameRef.current.trim() || saved.current.name };
    const incomplete = incompleteReason(next.configuration);
    setUnsavedReason(incomplete ? `${incomplete.message} Changes save once the automation is complete.` : null);
    if (incomplete) return;
    const snapshot = JSON.stringify(next);
    if (snapshot === queuedSnapshot.current) return;
    queuedSnapshot.current = snapshot;
    const saveId = ++latestSave.current;
    setError(null);
    enqueue(async () => {
      try {
        await saveAutomation(automationId, { ...next, description, enabled: enabledRef.current });
        saved.current = next;
        setSavedName(next.name);
      } catch (cause) {
        if (latestSave.current === saveId) {
          queuedSnapshot.current = JSON.stringify(saved.current);
          configurationRef.current = saved.current.configuration;
          nameRef.current = saved.current.name;
          setConfiguration(saved.current.configuration);
          setName(saved.current.name);
          setGithubIncluded(saved.current.configuration.repositoryIds.length > 0);
        }
        setSaveStatus("idle");
        setError(cause instanceof Error ? cause.message : "Unable to save automation");
      }
    });
  }

  const optionsLoaded = useEffectEvent((loadedOptions: AutomationOptions, isCancelled: () => boolean) => {
    setOptions(loadedOptions);
    const restored = restoreAutomationDraft(loadedOptions, window.location, automationId);
    // Saved settings and drafts can reference connections removed since. The
    // page cannot show them and the server rejects them, so drop them. The
    // cleaned saved settings are what a failed save returns to.
    if (automationId) {
      saved.current = { ...saved.current, configuration: availableAutomationConfiguration(saved.current.configuration, loadedOptions) };
      queuedSnapshot.current = JSON.stringify(saved.current);
    }
    if (!restored) {
      if (automationId) updateConfiguration(() => saved.current.configuration, false);
      else updateConfiguration((current) => {
        const blank = { ...current, model: "", modelCredentialId: null, repositoryIds: [] };
        return template ? applyAutomationTemplate(blank, template, loadedOptions) : blank;
      }, false);
      return;
    }
    setTemplate(findAutomationTemplate(restored.draft.templateId));
    nameRef.current = restored.draft.name;
    setName(restored.draft.name);
    setGithubIncluded(restored.draft.githubIncluded);
    updateConfiguration(() => availableAutomationConfiguration(restored.draft.configuration, loadedOptions));
    if (restored.error) setError(restored.error);
    window.history.replaceState(window.history.state, "", editorPath);
    if (!restored.finishing) return;
    const { draft } = restored;
    void waitForConnectedAccounts(draft, restored.returnedAccountId, isCancelled).then((result) => {
      if (isCancelled()) return;
      if (!result) {
        setError(`${providerDisplayName(draft.connecting)} connected, but it is not available yet. Add it from Add connector in a moment.`);
        return;
      }
      setOptions(result.options);
      if (draft.connecting === "github") setGithubIncluded(true);
      else updateConfiguration((current) => ({ ...current, contextAccountIds: [...new Set([...current.contextAccountIds, ...result.accountIds])] }));
    });
  });

  useEffect(() => {
    let cancelled = false;
    void fetchAutomationOptions()
      .then((loadedOptions) => {
        if (!cancelled) optionsLoaded(loadedOptions, () => cancelled);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load automation");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Connects in this tab. OAuth providers redirect; Datadog and custom MCP
  // collect credentials in a dialog first. Both return to this page.
  async function connectConnector(provider: AutomationConnectorProvider) {
    setError(null);
    try {
      const response = await fetch("/api/integrations");
      if (!response.ok) throw new Error("Unable to load connections. Please try again.");
      const { integrations } = await response.json() as { integrations: Array<{ id: string; connectUrl: string | null }> };
      const connectUrl = integrations.find((integration) => integration.id === provider)?.connectUrl;
      if (!connectUrl) throw new Error(`${providerDisplayName(provider)} connections are not configured for this installation.`);
      saveAutomationDraft({ automationId, name, configuration, templateId: template?.id, githubIncluded, connecting: provider, knownAccountIds: options?.accounts.filter((account) => account.provider === provider).map((account) => account.id) ?? [], savedAt: Date.now() });
      if (provider === "datadog" || provider === "custom_mcp") {
        setConnectDialog({ provider, connectUrl });
        return;
      }
      const url = new URL(connectUrl, window.location.origin);
      url.searchParams.set("returnTo", editorPath);
      window.location.assign(url.toString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the connection.");
    }
  }

  const selectedTriggerAccountIds = triggerAccountIds(configuration.triggers);
  const contextAccounts = options?.accounts.filter((account) =>
    !selectedTriggerAccountIds.includes(account.id) &&
    ["custom_mcp", "datadog", "sentry", "slack"].includes(account.provider)
  ) ?? [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (automationId) return;
    const incomplete = incompleteReason(configuration);
    if (incomplete) {
      setError(incomplete.message);
      if (incomplete.field === "trigger") {
        if (!configuration.triggers.length) setTriggerMenuOpen(true);
        triggerSectionRef.current?.scrollIntoView({ block: "nearest" });
      } else if (incomplete.field === "repositories") setRepositoryPickerOpen(true);
      else setModelRequestedOpen((value) => value + 1);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const id = await saveAutomation(undefined, { configuration, description, enabled, name });
      navigate(`/automations/${id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save automation");
      setSaving(false);
    }
  }

  // Clears what the template filled in and keeps the model and repositories.
  function startBlank() {
    setTemplate(undefined);
    nameRef.current = "New automation";
    setName(nameRef.current);
    setError(null);
    updateConfiguration((current) => ({ ...current, contextAccountIds: [], prompt: "", triggers: [] }), false);
    window.history.replaceState(window.history.state, "", editorPath);
  }

  function updateEnabled(next: boolean) {
    if (!automationId) return;
    const previous = enabledRef.current;
    enabledRef.current = next;
    setEnabled(next);
    setError(null);
    enqueue(async () => {
      try {
        await setAutomationEnabled(automationId, next);
      } catch (cause) {
        if (enabledRef.current === next) {
          enabledRef.current = previous;
          setEnabled(previous);
        }
        setSaveStatus("idle");
        setError(cause instanceof Error ? cause.message : "Unable to update automation status");
      }
    });
  }

  async function startRun() {
    if (!automationId) return;
    setStartingRun(true);
    setError(null);
    try {
      await runAutomation(automationId);
      setRunsRefreshKey((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start automation");
    } finally {
      setStartingRun(false);
    }
  }

  if (loading) {
    return <AppShell active="automations" redesigned density="create"><p className="automationLoading">Loading automation…</p></AppShell>;
  }

  // In run order: the first repository is the agent's working directory.
  const selectedRepositories = configuration.repositoryIds.flatMap((id) => options?.repositories.find((repository) => repository.id === id) ?? []);
  const selectedConnectors = contextAccounts.filter((account) => configuration.contextAccountIds.includes(account.id));
  const selectedSecrets = options?.secrets.filter((secret) => configuration.workspaceSecretIds.includes(secret.id)) ?? [];
  const repositoryPicker = <AutomationRepositoryPicker options={options} selectedIds={configuration.repositoryIds} open={repositoryPickerOpen} onOpenChange={setRepositoryPickerOpen} onToggle={(repositoryId) => {
    setGithubIncluded(true);
    updateConfiguration((current) => ({ ...current, repositoryIds: toggle(current.repositoryIds, repositoryId) }));
  }} onGithubConnected={async (_kind, signal) => {
    const loaded = await fetchAutomationOptions();
    if (signal.aborted) return false;
    setOptions(loaded);
    const connected = loaded.accounts.some((account) => account.provider === "github");
    if (connected) setRepositoryPickerOpen(true);
    return connected;
  }} />;
  return (
    <AppShell active="automations" redesigned density="create">
      <div className="automationCreate">
        <header className="automationCreate__header">
          <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb"><Link to="/automations">Automations</Link><span aria-hidden="true">›</span><span>{automationId ? savedName : template ? "New from template" : "Create automation"}</span></nav>
          <div className="automationCreate__titleRow">
            {renaming ? <input aria-label="Automation name" autoFocus className="automationCreate__name" maxLength={120} onBlur={() => { if (!name.trim()) { nameRef.current = savedName || "New automation"; setName(nameRef.current); } setRenaming(false); persist(); }} onChange={(event) => { nameRef.current = event.target.value; setName(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); } }} value={name} /> : <h1>{name}</h1>}
            {activeTab === "settings" ? <button aria-label="Rename automation" className="automationCreate__iconButton" onClick={() => setRenaming(true)} type="button"><PencilSimpleIcon size={14} /></button> : null}
            <span className="automationCreate__spacer" />
            {automationId && saveStatus !== "idle" ? <span aria-live="polite" className="automationCreate__saveStatus">{saveStatus === "saving" ? "Saving…" : "Saved"}</span> : null}
            {automationId ? <Switch checked={enabled} className="automationCreate__status" label="Active" onCheckedChange={updateEnabled} /> : null}
            {!automationId
              ? <button className="automationCreate__save" disabled={saving || !options} form="automation-settings" type="submit"><FloppyDiskIcon size={14} />{saving ? "Saving…" : "Save"}</button>
              : activeTab === "history" ? <button className="automationCreate__secondary" disabled={startingRun || !enabled} onClick={() => void startRun()} title={enabled ? undefined : "Turn the automation on to run it"} type="button"><PlayIcon size={14} />{startingRun ? "Starting…" : "Run now"}</button> : null}
            {automationId ? <button className="automationCreate__save" disabled={!enabled || saveStatus === "saving"} onClick={() => navigate(`/automations/${automationId}/test`)} title={enabled ? "Chat with the agent to test this automation" : "Turn the automation on to test it"} type="button"><ChatCircleIcon size={14} />Test</button> : null}
          </div>
          {automationId ? <div className="automationCreate__tabs" role="tablist" aria-label="Automation sections">
            <button aria-selected={activeTab === "settings"} onClick={() => setActiveTab("settings")} role="tab" type="button">Settings</button>
            <button aria-selected={activeTab === "history"} onClick={() => { setActiveTab("history"); setRenaming(false); }} role="tab" type="button">Run history</button>
          </div> : null}
        </header>
        {template && !automationId ? <div className="automationCreate__template" role="status">
          <SquaresFourIcon aria-hidden="true" size={16} />
          <p>Started from the {template.name} template. Choose {automationTemplateMissingFields(template)}, then save.</p>
          <button onClick={startBlank} type="button">Start blank</button>
        </div> : null}
        {error ? <p className="formError" role="alert">{error}</p> : null}
        {unsavedReason && activeTab === "settings" ? <p className="automationCreate__unsaved" role="status">{unsavedReason}</p> : null}
        {automationId && activeTab === "history" ? <AutomationRunHistory automationId={automationId} refreshKey={runsRefreshKey} /> : null}
        <form className="automationCreate__form" hidden={activeTab !== "settings"} id="automation-settings" onSubmit={(event) => void submit(event)}>
          <section className="automationCreate__section automationCreate__section--trigger" aria-labelledby="automation-triggers" ref={triggerSectionRef}>
            <h2 id="automation-triggers">Triggers</h2>
            <AutomationTriggerEditor options={options} triggers={configuration.triggers} open={triggerMenuOpen} onOpenChange={setTriggerMenuOpen} onRefresh={async (kind) => {
              const endpoint = kind === "slack" ? "/api/agents/options/refresh/slack" : "/api/integrations/sentry/check";
              const response = await fetch(endpoint, { method: "POST" });
              if (!response.ok) throw new Error("Could not refresh trigger resources");
              setOptions(await fetchAutomationOptions());
            }} onConnected={async (kind, signal) => {
              const loaded = await fetchAutomationOptions();
              if (signal.aborted) return false;
              setOptions(loaded);
              const account = loaded.accounts.find((item) => item.provider === kind);
              if (!account) return false;
              // Triggers waiting for this provider use the new connection.
              updateConfiguration((current) => ({
                ...current,
                contextAccountIds: current.contextAccountIds.filter((id) => id !== account.id),
                triggers: current.triggers.map((trigger) => trigger.kind === kind && !trigger.integrationAccountId ? { ...trigger, integrationAccountId: account.id } : trigger),
              }));
              return true;
            }} onChange={(triggers) => {
              setError(null);
              const accountIds = triggerAccountIds(triggers);
              updateConfiguration((current) => ({ ...current, contextAccountIds: current.contextAccountIds.filter((id) => !accountIds.includes(id)), triggers }));
            }} />
          </section>
          <section className="automationCreate__section" aria-labelledby="automation-instructions">
            <h2 id="automation-instructions">Agent instructions</h2>
            <div className="automationCreate__instructions">
              <textarea aria-labelledby="automation-instructions" maxLength={50_000} onBlur={() => persist()} onChange={(event) => { const prompt = event.target.value; updateConfiguration((current) => ({ ...current, prompt }), false); }} placeholder="Describe what the agent should do." required value={configuration.prompt} />
              <div className="automationCreate__toolbar">
                <AutomationModelPicker configuration={configuration} options={options} onChange={(patch) => updateConfiguration((current) => ({ ...current, ...patch }))} requestedOpen={modelRequestedOpen} />
              </div>
            </div>
          </section>
          <section className="automationCreate__section" aria-labelledby="automation-repositories">
            <h2 id="automation-repositories">Repositories</h2>
            {selectedRepositories.length ? <AutomationRepositoryList
              onMove={(repositoryId, index) => updateConfiguration((current) => ({ ...current, repositoryIds: moveItem(current.repositoryIds, repositoryId, index) }))}
              onRemove={(repositoryId) => updateConfiguration((current) => ({ ...current, repositoryIds: current.repositoryIds.filter((id) => id !== repositoryId) }))}
              picker={repositoryPicker}
              repositories={selectedRepositories}
            /> : repositoryPicker}
          </section>
          <section className="automationCreate__section" aria-labelledby="automation-connectors">
            <h2 id="automation-connectors">Connectors</h2>
            <div className="automationCreate__rows">
              {githubIncluded && options?.repositories.length ? <div className="automationCreate__row"><GithubLogoIcon size={16} weight="fill" /><span>GitHub</span><Link className="automationCreate__manage" to="/settings">Manage</Link><button aria-label="Remove GitHub connector" className="automationCreate__iconButton" onClick={() => { setGithubIncluded(false); updateConfiguration((current) => ({ ...current, repositoryIds: [] })); }} type="button"><TrashIcon size={14} /></button></div> : null}
              {selectedConnectors.map((account) => <div className="automationCreate__row" key={account.id}><ProviderGlyph decorative provider={account.provider as AutomationConnectorProvider} /><span>{account.displayName}</span><Link className="automationCreate__manage" to="/settings">Manage</Link><button aria-label={`Remove ${account.displayName}`} className="automationCreate__iconButton" onClick={() => updateConfiguration((current) => ({ ...current, contextAccountIds: current.contextAccountIds.filter((id) => id !== account.id) }))} type="button"><TrashIcon size={14} /></button></div>)}
              {selectedSecrets.map((secret) => <div className="automationCreate__row" key={secret.id}><KeyIcon size={16} /><span>{secret.name}</span><button aria-label={`Remove ${secret.name}`} className="automationCreate__iconButton" onClick={() => updateConfiguration((current) => ({ ...current, workspaceSecretIds: current.workspaceSecretIds.filter((id) => id !== secret.id) }))} type="button"><TrashIcon size={14} /></button></div>)}
              <AutomationConnectorPicker options={options} triggerAccountIds={selectedTriggerAccountIds} selectedAccountIds={configuration.contextAccountIds} selectedSecretIds={configuration.workspaceSecretIds} githubIncluded={githubIncluded}
                onToggleAccount={(accountId) => updateConfiguration((current) => ({ ...current, contextAccountIds: toggle(current.contextAccountIds, accountId) }))}
                onToggleSecret={(secretId) => updateConfiguration((current) => ({ ...current, workspaceSecretIds: toggle(current.workspaceSecretIds, secretId) }))}
                onToggleGithub={() => { if (githubIncluded) updateConfiguration((current) => ({ ...current, repositoryIds: [] })); setGithubIncluded(!githubIncluded); }}
                onConnect={(provider) => void connectConnector(provider)} />
            </div>
          </section>
        </form>
      </div>
      <DatadogConnectionDialog connectUrl={connectDialog?.connectUrl ?? ""} open={connectDialog?.provider === "datadog"} onCancel={() => { takeAutomationDraft(); setConnectDialog(null); }} returnTo={editorPath} />
      <CustomMcpConnectionDialog connectUrl={connectDialog?.connectUrl ?? ""} open={connectDialog?.provider === "custom_mcp"} onCancel={() => { takeAutomationDraft(); setConnectDialog(null); }} returnTo={editorPath} />
    </AppShell>
  );
}
