import { type FormEvent, useEffect, useMemo, useState } from "react";
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
import { AppShell } from "../components/app-shell";
import { useDocumentTitle } from "../use-document-title";

const defaultConfiguration: AutomationConfiguration = {
  contextAccountIds: [],
  harness: "codex",
  maxModelRequests: 24,
  maxOutputTokensPerRequest: 16_000,
  maxRuntimeSeconds: 1_800,
  model: "gpt-5.4",
  modelCredentialId: "",
  modelProvider: "openai",
  prompt: "",
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [configuration, setConfiguration] = useState(defaultConfiguration);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCredential, setShowCredential] = useState(false);
  const [credentialLabel, setCredentialLabel] = useState("");
  const [credentialKey, setCredentialKey] = useState("");
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [picker, setPicker] = useState<"trigger" | "connector" | "repository" | null>(null);
  const [triggerChosen, setTriggerChosen] = useState(Boolean(automationId));
  useEffect(() => {
    if (!picker) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setPicker(null); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [picker]);
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
          setTriggerChosen(true);
        } else {
          const firstCredential = loadedOptions.credentials.find(
            (credential) => credential.status === "active",
          );
          setConfiguration((current) => ({
            ...current,
            model: firstCredential?.provider === "anthropic"
              ? "claude-sonnet-4-5"
              : "gpt-5.4",
            modelCredentialId: firstCredential?.id ?? "",
            modelProvider: firstCredential?.provider ?? "openai",
            repositoryIds: [],
          }));
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
    const credential = options?.credentials.find(
      (item) => item.provider === provider && item.status === "active",
    );
    setConfiguration((current) => ({
      ...current,
      harness: current.harness === "claude_agent_sdk" && provider !== "anthropic"
        ? "codex"
        : current.harness,
      model: provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.4",
      modelCredentialId: credential?.id ?? "",
      modelProvider: provider,
    }));
  }

  function setTriggerKind(kind: "slack" | "sentry" | "discord") {
    setTriggerChosen(true);
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

  if (loading) {
    return <AppShell active="automations"><p className="automationLoading">Loading automation…</p></AppShell>;
  }

  return (
    <AppShell active="automations" density="create">
      <div className="automationCanvas automationCanvas--editor">
      <nav className="automationBreadcrumb"><Link to="/automations">Automations</Link><span>›</span>{automationId ? "Edit automation" : "Create automation"}</nav>
      {error ? <p className="formError">{error}</p> : null}
      <form className="automationEditor" onSubmit={(event) => void submit(event)}>
        <header className="automationTopline"><label className="srOnly" htmlFor="automation-name">Automation name</label><input id="automation-name" className="automationNameInput" maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="New automation" required value={name} /><button className="automationSave" disabled={saving || !triggerChosen} type="submit">{saving ? "Saving…" : "Save"}</button></header>
        <section className="automationSection"><h2>Triggers</h2>{triggerChosen ? <div className="automationTriggerCard"><div className="automationTriggerHead"><span className="automationProviderIcon">{configuration.trigger.kind[0].toUpperCase()}</span><strong>{configuration.trigger.kind[0].toUpperCase() + configuration.trigger.kind.slice(1)}</strong><span>{triggerAccounts.find((account) => account.id === configuration.trigger.integrationAccountId)?.displayName}</span><button onClick={() => setPicker("trigger")} type="button">Change</button></div>{triggerAccounts.length === 0 ? <p className="automationFormHint">No {configuration.trigger.kind} connection is available. <Link to="/settings">Connect it in Settings ↗</Link></p> : null}<div className="automationFieldGrid"><label>Connection<select onChange={(event) => setConfiguration((current) => ({ ...current, trigger: { ...current.trigger, integrationAccountId: event.target.value } }))} required value={configuration.trigger.integrationAccountId}><option value="">Choose a connection</option>{triggerAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>{configuration.trigger.kind === "slack" ? <label>Event<select onChange={(event) => setConfiguration((current) => ({ ...current, trigger: current.trigger.kind === "slack" ? { ...current.trigger, eventMode: event.target.value as "mentions" | "every_message" | "both" } : current.trigger }))} value={configuration.trigger.eventMode}><option value="mentions">App mentioned</option><option value="every_message">Message posted</option><option value="both">Either event</option></select></label> : null}</div>{configuration.trigger.kind === "sentry" ? <div className="automationChecks"><span>Event</span>{(["new_issue", "regression"] as const).map((eventType) => <label key={eventType}><input checked={configuration.trigger.kind === "sentry" && configuration.trigger.eventTypes.includes(eventType)} onChange={() => setConfiguration((current) => ({ ...current, trigger: current.trigger.kind === "sentry" ? { ...current.trigger, eventTypes: toggle(current.trigger.eventTypes, eventType) as Array<"new_issue" | "regression"> } : current.trigger }))} type="checkbox" />{eventType === "new_issue" ? "New issue" : "Regression"}</label>)}</div> : null}<div className="automationChecks"><span>{configuration.trigger.kind === "sentry" ? "Projects" : "Channels"}</span>{triggerResources.length ? triggerResources.map((resource) => { const selected = configuration.trigger.kind === "sentry" ? configuration.trigger.projectIds : configuration.trigger.channelIds; return <label key={resource.id}><input checked={selected.includes(resource.externalId)} onChange={() => setConfiguration((current) => ({ ...current, trigger: current.trigger.kind === "sentry" ? { ...current.trigger, projectIds: toggle(current.trigger.projectIds, resource.externalId) } : { ...current.trigger, channelIds: toggle(current.trigger.channelIds, resource.externalId) } }))} type="checkbox" />{resource.displayName}</label>; }) : <small>No synced resources found for this connection.</small>}</div></div> : null}<button className="automationAddRow" onClick={() => setPicker("trigger")} type="button">＋ Add trigger</button><p className="automationFormHint">Every matching event starts a run.</p></section>
        <section className="automationSection"><h2>Agent instructions</h2><label className="srOnly" htmlFor="automation-instructions">Agent instructions</label><textarea id="automation-instructions" className="automationInstructions" maxLength={50_000} onChange={(event) => setConfiguration((current) => ({ ...current, prompt: event.target.value }))} placeholder="Describe what the agent should do." required value={configuration.prompt} /><div className="automationModelBar"><label>Provider<select onChange={(event) => setProvider(event.target.value as AutomationModelProvider)} value={configuration.modelProvider}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label><label>Model<input onChange={(event) => setConfiguration((current) => ({ ...current, model: event.target.value }))} required value={configuration.model} /></label><label>Harness<select onChange={(event) => setConfiguration((current) => ({ ...current, harness: event.target.value as AutomationHarness }))} value={configuration.harness}><option value="codex">Default</option><option disabled={configuration.modelProvider !== "anthropic"} value="claude_agent_sdk">Claude Agent SDK</option><option value="opencode">OpenCode</option></select></label></div><div className="automationModelBar"><label>Model key<select onChange={(event) => setConfiguration((current) => ({ ...current, modelCredentialId: event.target.value }))} required value={configuration.modelCredentialId}><option value="">Choose a key</option>{providerCredentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label} ·••••{credential.lastFour}</option>)}</select></label><button className="automationTextButton" onClick={() => setShowCredential((value) => !value)} type="button">{showCredential ? "Cancel" : "＋ Add model key"}</button></div>{showCredential ? <div className="automationCredentialForm"><label className="field"><span>Key label</span><input onChange={(event) => setCredentialLabel(event.target.value)} value={credentialLabel} /></label><label className="field"><span>API key</span><input autoComplete="off" onChange={(event) => setCredentialKey(event.target.value)} type="password" value={credentialKey} /></label><button className="button button--secondary" disabled={credentialSaving || !credentialKey || !credentialLabel} onClick={() => void addCredential()} type="button">{credentialSaving ? "Saving…" : "Save key"}</button></div> : null}</section>
        <section className="automationSection"><h2>Repositories</h2>{options?.repositories.filter((repository) => configuration.repositoryIds.includes(repository.id)).map((repository) => <div className="automationSelectedRow" key={repository.id}><span className="automationProviderIcon">G</span><strong>{repository.fullName}</strong><button aria-label={`Remove ${repository.fullName}`} onClick={() => setConfiguration((current) => ({ ...current, repositoryIds: toggle(current.repositoryIds, repository.id) }))} type="button">×</button></div>)}<button className="automationAddRow" onClick={() => setPicker("repository")} type="button">＋ Add repository</button></section>
        <section className="automationSection"><h2>Connectors</h2><div className="automationSelectedRow"><span className="automationProviderIcon">G</span><strong>GitHub</strong><Link to="/settings">Manage</Link></div>{contextAccounts.filter((account) => configuration.contextAccountIds.includes(account.id)).map((account) => <div className="automationSelectedRow" key={account.id}><span className="automationProviderIcon">{account.provider[0].toUpperCase()}</span><strong>{account.displayName}</strong><button aria-label={`Remove ${account.displayName}`} onClick={() => setConfiguration((current) => ({ ...current, contextAccountIds: toggle(current.contextAccountIds, account.id) }))} type="button">×</button></div>)}<button className="automationAddRow" onClick={() => setPicker("connector")} type="button">＋ Add connector</button></section>
        <details className="automationAdvanced"><summary>Advanced settings</summary><label>Description<textarea maxLength={2_000} onChange={(event) => setDescription(event.target.value)} value={description} /></label><label className="automationToggle"><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />Active after saving</label><div className="automationModelBar"><label>Maximum runtime (seconds)<input max={3600} min={60} onChange={(event) => setConfiguration((current) => ({ ...current, maxRuntimeSeconds: Number(event.target.value) }))} type="number" value={configuration.maxRuntimeSeconds} /></label><label>Maximum model calls<input max={128} min={1} onChange={(event) => setConfiguration((current) => ({ ...current, maxModelRequests: Number(event.target.value) }))} type="number" value={configuration.maxModelRequests} /></label><label>Output tokens per call<input max={100000} min={256} onChange={(event) => setConfiguration((current) => ({ ...current, maxOutputTokensPerRequest: Number(event.target.value) }))} type="number" value={configuration.maxOutputTokensPerRequest} /></label></div><div className="automationChecks"><span>Workspace secrets</span>{options?.secrets.map((secret) => <label key={secret.id}><input checked={configuration.workspaceSecretIds.includes(secret.id)} onChange={() => setConfiguration((current) => ({ ...current, workspaceSecretIds: toggle(current.workspaceSecretIds, secret.id) }))} type="checkbox" />{secret.name}</label>)}</div><p className="automationFormHint">Runs use a fresh sandbox. Selected connections can perform supported write actions without approval.</p></details>
      </form>
      {picker ? <div className="automationModalBackdrop" onClick={() => setPicker(null)}><section aria-label={picker === "trigger" ? "Choose a trigger" : picker === "connector" ? "Add connector" : "Add repository"} aria-modal="true" className="automationPicker" onClick={(event) => event.stopPropagation()} role="dialog"><header><h2>{picker === "trigger" ? "Choose a trigger" : picker === "connector" ? "Give the agent access to your tools" : "Add repository"}</h2><button aria-label="Close" onClick={() => setPicker(null)} type="button">×</button></header>{picker === "trigger" ? <>{(["slack", "sentry", "discord"] as const).map((kind) => <button className="automationPickerRow" key={kind} onClick={() => { setTriggerKind(kind); setPicker(null); }} type="button"><span className="automationProviderIcon">{kind[0].toUpperCase()}</span><span><strong>{kind[0].toUpperCase() + kind.slice(1)}</strong><small>{kind === "slack" ? "Message posted or app mentioned" : kind === "sentry" ? "New issue or regression" : "Slash command in a channel"}</small></span><span>›</span></button>)}<p className="automationPickerNote">GitHub and Datadog triggers are not available yet.</p></> : picker === "repository" ? options?.repositories.map((repository) => <button className="automationPickerRow" key={repository.id} onClick={() => { setConfiguration((current) => ({ ...current, repositoryIds: toggle(current.repositoryIds, repository.id) })); }} type="button"><span className="automationProviderIcon">G</span><strong>{repository.fullName}</strong><span>{configuration.repositoryIds.includes(repository.id) ? "Added ✓" : "Add"}</span></button>) : contextAccounts.map((account) => <button className="automationPickerRow" key={account.id} onClick={() => setConfiguration((current) => ({ ...current, contextAccountIds: toggle(current.contextAccountIds, account.id) }))} type="button"><span className="automationProviderIcon">{account.provider[0].toUpperCase()}</span><span><strong>{account.displayName}</strong><small>{account.provider}</small></span><span>{configuration.contextAccountIds.includes(account.id) ? "Added ✓" : "Add"}</span></button>)}{picker !== "trigger" ? <Link className="automationPickerManage" to="/settings">Manage connections ↗</Link> : null}</section></div> : null}
      </div>
    </AppShell>
  );
}
