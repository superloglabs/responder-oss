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
          const firstCredential = loadedOptions.credentials.find(
            (credential) => credential.status === "active",
          );
          const firstRepository = loadedOptions.repositories[0];
          setConfiguration((current) => ({
            ...current,
            model: firstCredential?.provider === "anthropic"
              ? "claude-sonnet-4-5"
              : "gpt-5.4",
            modelCredentialId: firstCredential?.id ?? "",
            modelProvider: firstCredential?.provider ?? "openai",
            repositoryIds: firstRepository ? [firstRepository.id] : [],
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

        <section className="automationFormCard">
          <h2>Trigger</h2>
          <div className="inlineFields">
            <label className="field field--grow"><span>Provider</span><select onChange={(event) => setTriggerKind(event.target.value as "slack" | "sentry" | "discord")} value={configuration.trigger.kind}><option value="slack">Slack</option><option value="sentry">Sentry</option><option value="discord">Discord</option></select></label>
            <label className="field field--grow"><span>Connection</span><select onChange={(event) => setConfiguration((current) => ({ ...current, trigger: { ...current.trigger, integrationAccountId: event.target.value } }))} required value={configuration.trigger.integrationAccountId}><option value="">Choose a connection</option>{triggerAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>
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
        </section>

        <section className="automationFormCard">
          <h2>Model and harness</h2>
          <div className="inlineFields">
            <label className="field field--grow"><span>Provider</span><select onChange={(event) => setProvider(event.target.value as AutomationModelProvider)} value={configuration.modelProvider}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
            <label className="field field--grow"><span>Harness</span><select onChange={(event) => setConfiguration((current) => ({ ...current, harness: event.target.value as AutomationHarness }))} value={configuration.harness}><option value="codex">Default coding harness</option><option disabled={configuration.modelProvider !== "anthropic"} value="claude_agent_sdk">Anthropic agent harness</option><option value="opencode">OpenCode</option></select></label>
          </div>
          <div className="inlineFields">
            <label className="field field--grow"><span>Model</span><input onChange={(event) => setConfiguration((current) => ({ ...current, model: event.target.value }))} required value={configuration.model} /></label>
            <label className="field field--grow"><span>Model key</span><select onChange={(event) => setConfiguration((current) => ({ ...current, modelCredentialId: event.target.value }))} required value={configuration.modelCredentialId}><option value="">Choose a key</option>{providerCredentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label} ·••••{credential.lastFour}</option>)}</select></label>
          </div>
          <button className="button button--secondary" onClick={() => setShowCredential((value) => !value)} type="button">{showCredential ? "Cancel adding key" : "Add model key"}</button>
          {showCredential ? <div className="automationCredentialForm"><label className="field"><span>Key label</span><input onChange={(event) => setCredentialLabel(event.target.value)} required={showCredential} value={credentialLabel} /></label><label className="field"><span>API key</span><input autoComplete="off" onChange={(event) => setCredentialKey(event.target.value)} required={showCredential} type="password" value={credentialKey} /></label><button className="button button--secondary" disabled={credentialSaving || !credentialKey || !credentialLabel} onClick={() => void addCredential()} type="button">{credentialSaving ? "Saving…" : "Save key"}</button></div> : null}
        </section>

        <section className="automationFormCard">
          <h2>Task</h2>
          <label className="field field--instructions"><span>Instructions</span><textarea maxLength={50_000} onChange={(event) => setConfiguration((current) => ({ ...current, prompt: event.target.value }))} required value={configuration.prompt} /></label>
          <div className="inlineFields"><label className="field field--grow"><span>Maximum runtime (seconds)</span><input max={3600} min={60} onChange={(event) => setConfiguration((current) => ({ ...current, maxRuntimeSeconds: Number(event.target.value) }))} type="number" value={configuration.maxRuntimeSeconds} /></label><label className="field field--grow"><span>Maximum model calls</span><input max={128} min={1} onChange={(event) => setConfiguration((current) => ({ ...current, maxModelRequests: Number(event.target.value) }))} type="number" value={configuration.maxModelRequests} /></label><label className="field field--grow"><span>Output tokens per call</span><input max={100000} min={256} onChange={(event) => setConfiguration((current) => ({ ...current, maxOutputTokensPerRequest: Number(event.target.value) }))} type="number" value={configuration.maxOutputTokensPerRequest} /></label></div>
        </section>

        <section className="automationFormCard">
          <h2>Repositories</h2>
          <div className="automationChecks">{options?.repositories.length ? options.repositories.map((repository) => <label key={repository.id}><input checked={configuration.repositoryIds.includes(repository.id)} onChange={() => setConfiguration((current) => ({ ...current, repositoryIds: toggle(current.repositoryIds, repository.id) }))} type="checkbox" />{repository.fullName}</label>) : <small>Connect GitHub and sync at least one repository first.</small>}</div>
        </section>

        <section className="automationFormCard">
          <h2>Context and secrets</h2>
          <p className="automationFormHint">The trigger connection and selected Slack, Sentry, Datadog, or custom MCP connections are available through the run-scoped context broker. Selected GitHub repositories are checked out in the sandbox. Write actions execute without human approval.</p>
          <div className="automationChecks"><span>Connections</span>{contextAccounts.length ? contextAccounts.map((account) => <label key={account.id}><input checked={configuration.contextAccountIds.includes(account.id)} onChange={() => setConfiguration((current) => ({ ...current, contextAccountIds: toggle(current.contextAccountIds, account.id) }))} type="checkbox" />{account.displayName} · {account.provider}</label>) : <small>No additional compatible context connections found.</small>}</div>
          <div className="automationChecks"><span>Workspace secrets</span>{options?.secrets.length ? options.secrets.map((secret) => <label key={secret.id}><input checked={configuration.workspaceSecretIds.includes(secret.id)} onChange={() => setConfiguration((current) => ({ ...current, workspaceSecretIds: toggle(current.workspaceSecretIds, secret.id) }))} type="checkbox" />{secret.name}</label>) : <small>No workspace secrets selected.</small>}</div>
        </section>

        <div className="automationEditorActions"><Link className="button button--secondary" to={automationId ? `/automations/${automationId}` : "/automations"}>Cancel</Link><button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save automation"}</button></div>
      </form>
    </AppShell>
  );
}
