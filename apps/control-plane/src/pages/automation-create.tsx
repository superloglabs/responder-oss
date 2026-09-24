import { automationModelProviders, supportsAutomationHarness } from "../../../../packages/core/src/automations/model-providers";
import { type FormEvent, useEffect, useMemo, useState, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createAutomationCredential,
  fetchAutomation,
  fetchAutomationOptions,
  saveAutomation,
  type AutomationConfiguration,
  type AutomationHarness,
  type AutomationModelProvider,
  type AutomationOptions,
} from "../automations-api";
import { FloppyDiskIcon, PencilSimpleIcon, PlusIcon, TrashIcon, GithubLogoIcon, PlugsIcon } from "@phosphor-icons/react";
import { AutomationModelPicker } from "../components/automation-model-picker";
import { supportsIncludedUsage } from "../../../../packages/core/src/automations/model-pricing";
import { AutomationTriggerEditor } from "../components/automation-trigger-editor";
import { AutomationEditorDialog } from "../components/automation-editor-dialog";
import "./automation-create.css";
import { AppShell } from "../components/app-shell";
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
  trigger: {
    channelIds: [],
    eventMode: "mentions",
    integrationAccountId: "",
    kind: "slack",
  },
  workspaceSecretIds: [],
};

function toggle(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((candidate) => candidate !== value)
    : [...list, value];
}

export function AutomationCreatePage() {
  const { automationId } = useParams();
  const navigate = useNavigate();
  const [options, setOptions] = useState<AutomationOptions | null>(null);
  const [name, setName] = useState("New automation");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [configuration, setConfiguration] = useState({ ...defaultConfiguration, prompt: "" });
  const [panel, setPanel] = useState<"model" | "repositories" | "connectors" | null>(null);
  const [triggerSelected, setTriggerSelected] = useState(false);
  const [triggerMenuOpen, setTriggerMenuOpen] = useState(false);
  const triggerSectionRef = useRef<HTMLElement>(null);
  const [githubIncluded, setGithubIncluded] = useState(true);
  const [modelRequestedOpen, setModelRequestedOpen] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCredential, setShowCredential] = useState(false);
  const [credentialLabel, setCredentialLabel] = useState("");
  const [credentialKey, setCredentialKey] = useState("");
  const [credentialSaving, setCredentialSaving] = useState(false);
  useDocumentTitle(automationId ? "Edit automation" : "New automation");

  useEffect(() => {
    let cancelled = false;
    const load = automationId
      ? Promise.all([fetchAutomationOptions(), fetchAutomation(automationId)])
      : Promise.all([fetchAutomationOptions(), Promise.resolve(null)]);
    void load
      .then(([loadedOptions, automation]) => {
        if (cancelled) return;
        setOptions(loadedOptions);
        if (automation) {
          setName(automation.name);
          setDescription(automation.description);
          setEnabled(automation.enabled);
          setConfiguration(automation.configuration);
        } else {
          setConfiguration((current) => ({ ...current, model: "", modelCredentialId: null, repositoryIds: [] }));
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load automation");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [automationId]);

  const triggerAccounts = useMemo(
    () => options?.accounts.filter((account) =>
      account.provider === configuration.trigger.kind) ?? [],
    [configuration.trigger.kind, options],
  );
  const triggerResources = useMemo(() => {
    if (!options) return [];
    const kind = configuration.trigger.kind === "slack"
      ? "slack_channel"
      : configuration.trigger.kind === "sentry"
        ? "sentry_project"
        : "discord_channel";
    return options.resources.filter((resource) =>
      resource.integrationAccountId === configuration.trigger.integrationAccountId &&
      resource.kind === kind
    );
  }, [configuration.trigger, options]);
  const providerCredentials = options?.credentials.filter(
    (credential) =>
      credential.provider === configuration.modelProvider &&
      credential.status === "active",
  ) ?? [];
  const contextAccounts = options?.accounts.filter((account) =>
    account.id !== configuration.trigger.integrationAccountId &&
    ["custom_mcp", "datadog", "sentry", "slack"].includes(account.provider)
  ) ?? [];

  function setProvider(provider: AutomationModelProvider) {
    // A provider without included-usage models starts on its first key.
    const credential = !supportsIncludedUsage(provider)
      ? options?.credentials.find((item) => item.provider === provider && item.status === "active")
      : undefined;
    setConfiguration((current) => ({
      ...current,
      harness: !supportsAutomationHarness(provider, current.harness)
        ? provider === "openai" ? "codex" : provider === "anthropic" ? "claude_agent_sdk" : "opencode"
        : current.harness,
      model: "",
      modelCredentialId: credential?.id ?? null,
      modelProvider: provider,
    }));
  }

  function setTriggerKind(kind: "slack" | "sentry" | "discord") {
    const account = options?.accounts.find((item) => item.provider === kind);
    setConfiguration((current) => ({
      ...current,
      trigger: kind === "slack"
        ? { channelIds: [], eventMode: "mentions", integrationAccountId: account?.id ?? "", kind }
        : kind === "sentry"
          ? { eventTypes: ["new_issue", "regression"], integrationAccountId: account?.id ?? "", kind, projectIds: [] }
          : { channelIds: [], integrationAccountId: account?.id ?? "", kind },
    }));
  }

  async function addCredential() {
    setCredentialSaving(true);
    setError(null);
    try {
      const id = await createAutomationCredential({
        apiKey: credentialKey,
        label: credentialLabel,
        provider: configuration.modelProvider,
      });
      const loadedOptions = await fetchAutomationOptions();
      setOptions(loadedOptions);
      setConfiguration((current) => ({ ...current, modelCredentialId: id }));
      setCredentialKey("");
      setCredentialLabel("");
      setShowCredential(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save model key");
    } finally {
      setCredentialSaving(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!automationId) {
      const resources = configuration.trigger.kind === "sentry" ? configuration.trigger.projectIds : configuration.trigger.channelIds;
      if (!triggerSelected || !configuration.trigger.integrationAccountId || !resources.length || (configuration.trigger.kind === "sentry" && !configuration.trigger.eventTypes.length)) {
        setError("Choose a trigger connection and at least one channel or project and event.");
        if (!triggerSelected) setTriggerMenuOpen(true);
        triggerSectionRef.current?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (!configuration.repositoryIds.length) {
        setError("Choose at least one repository.");
        setPanel("repositories");
        return;
      }
      if (!configuration.model.trim()) {
        setError("Choose a model.");
        setModelRequestedOpen((value) => value + 1);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const id = await saveAutomation(automationId, {
        configuration,
        description,
        enabled,
        name,
      });
      navigate(`/automations/${id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save automation");
      setSaving(false);
    }
  }

  const triggerFields = (<>
<div className="inlineFields">
            <label className="field field--grow"><span>Provider</span><select onChange={(event) => setTriggerKind(event.target.value as "slack" | "sentry" | "discord")} value={configuration.trigger.kind}><option value="slack">Slack</option><option value="sentry">Sentry</option><option value="discord">Discord</option></select></label>
            <label className="field field--grow"><span>Connection</span><select onChange={(event) => setConfiguration((current) => ({ ...current, trigger: current.trigger.kind === "sentry" ? { ...current.trigger, integrationAccountId: event.target.value, projectIds: [] } : { ...current.trigger, integrationAccountId: event.target.value, channelIds: [] } }))} required value={configuration.trigger.integrationAccountId}><option value="">Choose a connection</option>{triggerAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>
          </div>
          {configuration.trigger.kind === "slack" ? (
            <label className="field"><span>Event mode</span><select onChange={(event) => setConfiguration((current) => ({ ...current, trigger: current.trigger.kind === "slack" ? { ...current.trigger, eventMode: event.target.value as "mentions" | "every_message" | "both" } : current.trigger }))} value={configuration.trigger.eventMode}><option value="mentions">Mentions</option><option value="every_message">Every message</option><option value="both">Both</option></select></label>
          ) : null}
          {configuration.trigger.kind === "sentry" ? (
            <div className="automationChecks"><span>Events</span>{(["new_issue", "regression"] as const).map((eventType) => <label key={eventType}><input checked={configuration.trigger.kind === "sentry" && configuration.trigger.eventTypes.includes(eventType)} onChange={() => setConfiguration((current) => ({ ...current, trigger: current.trigger.kind === "sentry" ? { ...current.trigger, eventTypes: toggle(current.trigger.eventTypes, eventType) as Array<"new_issue" | "regression"> } : current.trigger }))} type="checkbox" />{eventType.replaceAll("_", " ")}</label>)}</div>
          ) : null}
          <div className="automationChecks"><span>{configuration.trigger.kind === "sentry" ? "Projects" : "Channels"}</span>{triggerResources.length === 0 ? <small>No synced resources found for this connection.</small> : triggerResources.map((resource) => {
            const selected = configuration.trigger.kind === "sentry" ? configuration.trigger.projectIds : configuration.trigger.channelIds;
            return <label key={resource.id}><input checked={selected.includes(resource.externalId)} onChange={() => setConfiguration((current) => ({ ...current, trigger: current.trigger.kind === "sentry" ? { ...current.trigger, projectIds: toggle(current.trigger.projectIds, resource.externalId) } : { ...current.trigger, channelIds: toggle(current.trigger.channelIds, resource.externalId) } }))} type="checkbox" />{resource.displayName}</label>;
          })}</div>
  </>);
  const modelFields = (<>
<div className="inlineFields">
            <label className="field field--grow"><span>Provider</span><select onChange={(event) => setProvider(event.target.value as AutomationModelProvider)} value={configuration.modelProvider}>{automationModelProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
            <label className="field field--grow"><span>Harness</span><select onChange={(event) => setConfiguration((current) => ({ ...current, harness: event.target.value as AutomationHarness }))} value={configuration.harness}><option disabled={configuration.modelProvider !== "openai"} value="codex">Default coding harness</option><option disabled={configuration.modelProvider !== "anthropic"} value="claude_agent_sdk">Anthropic agent harness</option><option value="opencode">OpenCode</option></select></label>
          </div>
          <div className="inlineFields">
            <label className="field field--grow"><span>Model</span><input onChange={(event) => setConfiguration((current) => ({ ...current, model: event.target.value }))} required value={configuration.model} /></label>
            <label className="field field--grow"><span>Billing</span><select onChange={(event) => setConfiguration((current) => ({ ...current, modelCredentialId: event.target.value || null }))} value={configuration.modelCredentialId ?? ""}><option value="">Included usage</option>{providerCredentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label} ·••••{credential.lastFour}</option>)}</select></label>
          </div>
          <button className="button button--secondary" onClick={() => setShowCredential((value) => !value)} type="button">{showCredential ? "Cancel adding key" : "Add model key"}</button>
          {showCredential ? <div className="automationCredentialForm"><label className="field"><span>Key label</span><input onChange={(event) => setCredentialLabel(event.target.value)} required={showCredential} value={credentialLabel} /></label><label className="field"><span>API key</span><input autoComplete="off" onChange={(event) => setCredentialKey(event.target.value)} required={showCredential} type="password" value={credentialKey} /></label><button className="button button--secondary" disabled={credentialSaving || !credentialKey || !credentialLabel} onClick={() => void addCredential()} type="button">{credentialSaving ? "Saving…" : "Save key"}</button></div> : null}
  </>);
  const repositoryFields = (<>
<div className="automationChecks">{options?.repositories.length ? options.repositories.map((repository) => <label key={repository.id}><input checked={configuration.repositoryIds.includes(repository.id)} disabled={!configuration.repositoryIds.includes(repository.id) && configuration.repositoryIds.length >= 10} onChange={() => setConfiguration((current) => ({ ...current, repositoryIds: toggle(current.repositoryIds, repository.id) }))} type="checkbox" />{repository.fullName}</label>) : <small>Connect GitHub and sync at least one repository first.</small>}</div>
  </>);
  const connectorFields = (<>
<p className="automationFormHint">The trigger connection and selected Slack, Sentry, Datadog, or custom MCP connections are available through the run-scoped context broker. Selected GitHub repositories are checked out in the sandbox. Write actions execute without human approval.</p>
          <div className="automationChecks"><span>Connections</span>{contextAccounts.length ? contextAccounts.map((account) => <label key={account.id}><input checked={configuration.contextAccountIds.includes(account.id)} onChange={() => setConfiguration((current) => ({ ...current, contextAccountIds: toggle(current.contextAccountIds, account.id) }))} type="checkbox" />{account.displayName} · {account.provider}</label>) : <small>No additional compatible context connections found.</small>}</div>
          <div className="automationChecks"><span>Workspace secrets</span>{options?.secrets.length ? options.secrets.map((secret) => <label key={secret.id}><input checked={configuration.workspaceSecretIds.includes(secret.id)} onChange={() => setConfiguration((current) => ({ ...current, workspaceSecretIds: toggle(current.workspaceSecretIds, secret.id) }))} type="checkbox" />{secret.name}</label>) : <small>No workspace secrets selected.</small>}</div>
  </>);

  if (loading) {
    return <AppShell active="automations" redesigned={!automationId}><p className="automationLoading">Loading automation…</p></AppShell>;
  }

  if (!automationId) {
    const selectedRepositories = options?.repositories.filter((repository) => configuration.repositoryIds.includes(repository.id)) ?? [];
    const selectedConnectors = contextAccounts.filter((account) => configuration.contextAccountIds.includes(account.id));
    return (
      <AppShell active="automations" redesigned density="create">
        <form className="automationCreate" onSubmit={(event) => void submit(event)}>
          <header className="automationCreate__header">
            <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb"><Link to="/automations">Automations</Link><span aria-hidden="true">›</span><span>Create automation</span></nav>
            <div className="automationCreate__titleRow">
              {renaming ? <input aria-label="Automation name" autoFocus className="automationCreate__name" maxLength={120} onBlur={() => { if (!name.trim()) setName("New automation"); setRenaming(false); }} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); } }} value={name} /> : <h1>{name}</h1>}
              <button aria-label="Rename automation" className="automationCreate__iconButton" onClick={() => setRenaming(true)} type="button"><PencilSimpleIcon size={14} /></button>
              <button className="automationCreate__save" disabled={saving || !options} type="submit"><FloppyDiskIcon size={14} />{saving ? "Saving…" : "Save"}</button>
            </div>
          </header>
          {error && !panel ? <p className="formError" role="alert">{error}</p> : null}
          <section className="automationCreate__section automationCreate__section--trigger" aria-labelledby="automation-triggers" ref={triggerSectionRef}>
            <h2 id="automation-triggers">Triggers</h2>
            <AutomationTriggerEditor options={options} trigger={triggerSelected ? configuration.trigger : null} open={triggerMenuOpen} onOpenChange={setTriggerMenuOpen} onRefresh={async (kind) => {
              const endpoint = kind === "slack" ? "/api/agents/options/refresh/slack" : "/api/integrations/sentry/check";
              const response = await fetch(endpoint, { method: "POST" });
              if (!response.ok) throw new Error("Could not refresh trigger resources");
              setOptions(await fetchAutomationOptions());
            }} onConnected={async (kind, signal) => {
              const loaded = await fetchAutomationOptions();
              if (signal.aborted) return false;
              setOptions(loaded);
              const account = loaded.accounts.find((item) => item.provider === kind && (!configuration.trigger.integrationAccountId || item.id === configuration.trigger.integrationAccountId));
              if (!account) return false;
              setConfiguration((current) => current.trigger.kind === kind ? { ...current, contextAccountIds: current.contextAccountIds.filter(id => id !== account.id), trigger: { ...current.trigger, integrationAccountId: account.id } } : current);
              return true;
            }} onChange={(trigger) => {
              setTriggerSelected(trigger !== null);
              setError(null);
              setConfiguration((current) => ({ ...current, contextAccountIds: current.contextAccountIds.filter(id => id !== trigger?.integrationAccountId), trigger: trigger ?? (current.trigger.kind === "sentry" ? { ...current.trigger, integrationAccountId: "", projectIds: [] } : { ...current.trigger, integrationAccountId: "", channelIds: [] }) }));
            }} />
          </section>
          <section className="automationCreate__section" aria-labelledby="automation-instructions">
            <h2 id="automation-instructions">Agent instructions</h2>
            <div className="automationCreate__instructions">
              <textarea aria-labelledby="automation-instructions" maxLength={50_000} onChange={(event) => setConfiguration((current) => ({ ...current, prompt: event.target.value }))} placeholder="Describe what the agent should do." required value={configuration.prompt} />
              <div className="automationCreate__toolbar">
                <AutomationModelPicker configuration={configuration} options={options} onChange={(patch) => setConfiguration((current) => ({ ...current, ...patch }))} onOptions={setOptions} requestedOpen={modelRequestedOpen} />
              </div>
            </div>
          </section>
          <section className="automationCreate__section" aria-labelledby="automation-repositories">
            <h2 id="automation-repositories">Repositories</h2>
            {selectedRepositories.length ? <div className="automationCreate__rows">{selectedRepositories.map((repository) => <div className="automationCreate__row" key={repository.id}><GithubLogoIcon size={16} /><span>{repository.fullName}</span><button aria-label={`Remove ${repository.fullName}`} className="automationCreate__iconButton" onClick={() => setConfiguration((current) => ({ ...current, repositoryIds: current.repositoryIds.filter((id) => id !== repository.id) }))} type="button"><TrashIcon size={14} /></button></div>)}<button className="automationCreate__add" onClick={() => setPanel("repositories")} type="button"><PlusIcon size={16} />Add repository</button></div> : <button className="automationCreate__add" onClick={() => setPanel("repositories")} type="button"><PlusIcon size={16} />Add repository</button>}
          </section>
          <section className="automationCreate__section" aria-labelledby="automation-connectors">
            <h2 id="automation-connectors">Connectors</h2>
            <div className="automationCreate__rows">
              {githubIncluded && options?.repositories.length ? <div className="automationCreate__row"><GithubLogoIcon size={16} weight="fill" /><span>GitHub</span><Link className="automationCreate__manage" to="/settings">Manage</Link><button aria-label="Remove GitHub connector" className="automationCreate__iconButton" onClick={() => { setGithubIncluded(false); setConfiguration((current) => ({ ...current, repositoryIds: [] })); }} type="button"><TrashIcon size={14} /></button></div> : null}
              {selectedConnectors.map((account) => <div className="automationCreate__row" key={account.id}><PlugsIcon size={16} /><span>{account.displayName}</span><Link className="automationCreate__manage" to="/settings">Manage</Link><button aria-label={`Remove ${account.displayName}`} className="automationCreate__iconButton" onClick={() => setConfiguration((current) => ({ ...current, contextAccountIds: current.contextAccountIds.filter((id) => id !== account.id) }))} type="button"><TrashIcon size={14} /></button></div>)}
              <button className="automationCreate__add" onClick={() => setPanel("connectors")} type="button"><PlusIcon size={16} />Add connector</button>
            </div>
          </section>
        </form>
        {panel ? <AutomationEditorDialog title={{ model: "Model and harness", repositories: "Choose repositories", connectors: "Add connector" }[panel]} onClose={() => setPanel(null)}>
          {error ? <p className="formError" role="alert">{error}</p> : null}
          {panel === "model" ? <div className="automationCreate__modelFields">{modelFields}</div> : panel === "repositories" ? <div onChange={() => setGithubIncluded(true)}>{repositoryFields}</div> : <>{!githubIncluded && options?.repositories.length ? <button className="automationCreate__add" onClick={() => setGithubIncluded(true)} type="button"><PlusIcon size={16} />GitHub</button> : null}{connectorFields}</>}
        </AutomationEditorDialog> : null}
      </AppShell>
    );
  }

  return (
    <AppShell active="automations" density="create">
      <section className="detailHeading automationEditorHeading">
        <div>
          <Link className="investigationBackLink" to={automationId ? `/automations/${automationId}` : "/automations"}>← Automations</Link>
          <h1>{automationId ? "Edit automation" : "New automation"}</h1>
          <p>Each run gets a clean sandbox and the selected repositories and connections.</p>
        </div>
      </section>
      {error ? <p className="formError">{error}</p> : null}
      <form className="automationEditor" onSubmit={(event) => void submit(event)}>
        <section className="automationFormCard">
          <h2>Basics</h2>
          <div className="inlineFields">
            <label className="field field--grow"><span>Name</span><input maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></label>
            <label className="automationToggle"><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" /><span>Enabled</span></label>
          </div>
          <label className="field"><span>Description</span><textarea maxLength={2_000} onChange={(event) => setDescription(event.target.value)} value={description} /></label>
        </section>

        <section className="automationFormCard"><h2>Trigger</h2>{triggerFields}</section>

        <section className="automationFormCard"><h2>Model and harness</h2>{modelFields}</section>

        <section className="automationFormCard">
          <h2>Task</h2>
          <label className="field field--instructions"><span>Instructions</span><textarea maxLength={50_000} onChange={(event) => setConfiguration((current) => ({ ...current, prompt: event.target.value }))} required value={configuration.prompt} /></label>
          <div className="inlineFields"><label className="field field--grow"><span>Maximum runtime (seconds)</span><input max={3600} min={60} onChange={(event) => setConfiguration((current) => ({ ...current, maxRuntimeSeconds: Number(event.target.value) }))} type="number" value={configuration.maxRuntimeSeconds} /></label><label className="field field--grow"><span>Maximum model calls</span><input max={128} min={1} onChange={(event) => setConfiguration((current) => ({ ...current, maxModelRequests: Number(event.target.value) }))} type="number" value={configuration.maxModelRequests} /></label><label className="field field--grow"><span>Output tokens per call</span><input max={100000} min={256} onChange={(event) => setConfiguration((current) => ({ ...current, maxOutputTokensPerRequest: Number(event.target.value) }))} type="number" value={configuration.maxOutputTokensPerRequest} /></label></div>
        </section>

        <section className="automationFormCard"><h2>Repositories</h2>{repositoryFields}</section>

        <section className="automationFormCard"><h2>Context and secrets</h2>{connectorFields}</section>

        <div className="automationEditorActions"><Link className="button button--secondary" to={automationId ? `/automations/${automationId}` : "/automations"}>Cancel</Link><button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save automation"}</button></div>
      </form>
    </AppShell>
  );
}
