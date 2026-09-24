import { AutomationSubscriptionConnect } from "./automation-subscription-connect";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CaretDownIcon, CaretRightIcon, CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { createAutomationCredential, fetchAutomationModels, fetchAutomationOptions, type AvailableAutomationModel, type AutomationConfiguration, type AutomationOptions, type AutomationModelProvider } from "../automations-api";
import { automationModelProviders, modelProvider, supportsAutomationHarness } from "../../../../packages/core/src/automations/model-providers";
import "./automation-model-picker.css";

const harnesses = [
  { id: "codex" as const, name: "Codex", description: "Default coding harness" },
  { id: "claude_agent_sdk" as const, name: "Anthropic", description: "Anthropic agent harness" },
  { id: "opencode" as const, name: "OpenCode", description: "OpenCode agent harness" },
];
type Panel = "providers" | "models" | "connection" | "harness" | null;
export function AutomationModelPicker({ configuration, options, onChange, onOptions, requestedOpen }: {
  configuration: AutomationConfiguration;
  options: AutomationOptions | null;
  onChange: (patch: Partial<AutomationConfiguration>) => void;
  onOptions: (options: AutomationOptions) => void;
  requestedOpen: number;
}) {
  const [panel, setPanelState] = useState<Panel>(null);
  const [provider, setProvider] = useState<AutomationModelProvider>(configuration.modelProvider);
  const [credentialId, setCredentialId] = useState(configuration.modelCredentialId);
  const [method, setMethod] = useState<"api_key" | "chatgpt_subscription">("api_key");
  const [query, setQuery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<AvailableAutomationModel[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const harnessButton = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const providerName = modelProvider(provider).name;
  const credentials = options?.credentials.filter(item => item.provider === provider && item.status === "active") ?? [];
  const [lastRequestedOpen, setLastRequestedOpen] = useState(requestedOpen);
  function setPanel(value: Panel) { setRevision(0); setError(null); setQuery(""); setApiKey(""); if (value === "models") { setLoading(true); setModels([]); } setPanelState(value); }
  if (lastRequestedOpen !== requestedOpen) { setLastRequestedOpen(requestedOpen); setPanel("providers"); }
  useLayoutEffect(() => {
    if (!panel) return;
    const fit = () => {
      if (root.current) root.current.style.setProperty("--automation-menu-height", `${Math.max(120, window.innerHeight - root.current.getBoundingClientRect().bottom - 28)}px`);
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, true);
    return () => { window.removeEventListener("resize", fit); window.removeEventListener("scroll", fit, true); };
  }, [panel]);
  useEffect(() => {
    if (panel === "models") search.current?.focus();
    if (panel === "providers") root.current?.querySelector<HTMLButtonElement>(".automationModel__provider")?.focus();
    if (panel === "connection") keyInput.current?.focus();
    if (panel === "harness") root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus();
  }, [panel]);
  useEffect(() => {
    if (!panel) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && !saving) setPanel(null); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [panel, saving]);
  useEffect(() => {
    if (panel !== "models" || !credentialId) return;
    let active = true;
    void fetchAutomationModels(credentialId, revision > 0).then(result => { if (active) setModels(result.models); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load models."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [panel, credentialId, revision]);
  const subscriptionSelected = options?.credentials.some(item => item.id === configuration.modelCredentialId && item.authType === "chatgpt_subscription") ?? false;
  function chooseProvider(id: AutomationModelProvider) {
    setProvider(id);
    const credential = options?.credentials.find(item => item.id === configuration.modelCredentialId && item.provider === id && item.status === "active")
      ?? options?.credentials.find(item => item.provider === id && item.status === "active");
    setCredentialId(credential?.id ?? ""); setMethod("api_key"); setModels([]);
    setPanel(credential ? "models" : "connection");
  }
  async function connected(id: string) {
    onOptions(await fetchAutomationOptions());
    setCredentialId(id); setPanel("models");
  }
  async function connect() {
    setSaving(true); setError(null);
    try {
      const id = await createAutomationCredential({ provider, apiKey: apiKey.trim(), label: `${providerName} key ${crypto.randomUUID().slice(0, 8)}` });
      await connected(id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to connect API key"); }
    finally { setSaving(false); }
  }
  function refreshModels() { setLoading(true); setModels([]); setError(null); setRevision(value => value + 1); }
  function chooseModel(model: AvailableAutomationModel) {
    const subscription = credentials.some(item => item.id === credentialId && item.authType === "chatgpt_subscription");
    const harness = supportsAutomationHarness(provider, configuration.harness, subscription) ? configuration.harness
      : subscription || provider === "openai" ? "codex" : provider === "anthropic" ? "claude_agent_sdk" : "opencode";
    onChange({ modelProvider: provider, model: model.id, modelCredentialId: credentialId, harness });
    setPanel(null); modelButton.current?.focus();
  }
  return <div className="automationModel" ref={root} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !saving) setPanel(null);
  }} onKeyDown={event => {
    if (event.key === "Escape" && panel && !saving) { event.preventDefault(); const target = panel === "harness" ? harnessButton : modelButton; setPanel(null); target.current?.focus(); }
    if (event.key === "Enter" && event.target === search.current) { event.preventDefault(); root.current?.querySelector<HTMLButtonElement>(".automationModel__row")?.click(); }
    if (panel && ["ArrowDown", "ArrowUp"].includes(event.key) && panel !== "connection") {
      event.preventDefault();
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.automationModel__popover button:not(:disabled)') ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1) + buttons.length) % buttons.length]?.focus();
    }
  }}>
    <button className="automationModel__toggle" ref={modelButton} type="button" aria-expanded={!!panel && panel !== "harness"} onClick={() => setPanel(panel && panel !== "harness" ? null : "providers")} disabled={saving}>{configuration.model ? `Model: ${configuration.model}` : "Choose model"}<CaretDownIcon size={12} /></button>
    <span className="automationCreate__divider" />
    <button className="automationModel__toggle" ref={harnessButton} type="button" aria-expanded={panel === "harness"} onClick={() => setPanel(panel === "harness" ? null : "harness")} disabled={saving || !configuration.model}>Harness: {harnesses.find(item => item.id === configuration.harness)?.name}<CaretDownIcon size={12} /></button>
    {panel ? <div className={`automationModel__popover${panel === "providers" ? " automationModel__popover--providers" : ""}`} role={panel === "harness" ? "menu" : "dialog"} aria-label={panel === "providers" ? "Choose a provider" : panel === "models" ? `${providerName} models` : panel === "connection" ? `Connect ${providerName}` : "Choose a harness"}>
      {panel === "providers" || panel === "models" ? <>
        {panel === "models" ? <div className="automationModel__heading"><button type="button" onClick={() => setPanel("providers")}>← Providers</button><strong>{providerName}</strong></div> : null}
        {panel === "models" ? <label className="automationModel__search"><MagnifyingGlassIcon size={16} /><input aria-label="Search models" placeholder="Search models…" ref={search} value={query} onChange={event => setQuery(event.target.value)} /></label> : null}
        {panel === "providers" ? <>
          {automationModelProviders.map(item => <button key={item.id} type="button" className="automationModel__row automationModel__provider" onClick={() => chooseProvider(item.id)}><img className="automationModel__providerIcon" src={`/model-providers/${item.id}.svg`} alt="" aria-hidden="true" /><span>{item.name}</span>{options?.credentials.some(credential => credential.provider === item.id && credential.status === "active") ? <CaretRightIcon size={14} aria-hidden="true" /> : null}</button>)}
        </> : <>
          {credentials.length > 1 ? <label className="automationModel__key"><span>Connection</span><select aria-label="Model connection" value={credentialId} onChange={event => { setLoading(true); setModels([]); setError(null); setRevision(0); setCredentialId(event.target.value); }}>{credentials.map(item => <option key={item.id} value={item.id}>{item.label}{item.authType === "chatgpt_subscription" ? " · Subscription" : ""}</option>)}</select></label> : null}
          {loading ? <p className="automationModel__hint" role="status">{credentials.some(item => item.id === credentialId && item.authType === "chatgpt_subscription") ? "Loading subscription models… The first load may take up to a minute." : "Loading available models…"}</p> : error ? <div className="automationModel__footer"><p role="alert">{error}</p><button type="button" onClick={() => refreshModels()}>Retry</button></div> : <>
            {models.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase().trim())).map(item => <button className="automationModel__row" key={item.id} type="button" onClick={() => chooseModel(item)}><span>{item.name}{item.name !== item.id ? <small>{item.id}</small> : null}</span>{configuration.modelCredentialId === credentialId && configuration.model === item.id ? <CheckIcon size={14} /> : null}</button>)}
            {!models.length ? <p className="automationModel__hint">No automation models are available for this connection.</p> : !models.some(item => `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase().trim())) ? <p className="automationModel__hint">No matching models.</p> : null}
          </>}
          <div className="automationModel__footer"><button type="button" disabled={loading} onClick={() => refreshModels()}>Refresh models</button><button type="button" onClick={() => setPanel("connection")}>Add connection</button></div>
        </>}
      </> : panel === "connection" ? <>
        <div className="automationModel__heading"><button type="button" disabled={saving} onClick={() => setPanel("providers")}>← Providers</button><strong>Connect {providerName}</strong></div>
        {credentials.map(credential => <button className="automationModel__row" key={credential.id} type="button" disabled={saving} onClick={() => { setCredentialId(credential.id); setPanel("models"); }}><span>{credential.label}{credential.authType === "chatgpt_subscription" ? " · Subscription" : ` · ••••${credential.lastFour}`}</span><CaretRightIcon size={14} /></button>)}
        <div className="automationModel__methods"><button type="button" aria-pressed={method === "api_key"} disabled={saving} onClick={() => setMethod("api_key")}>API key · BYOK</button>{provider === "openai" ? <button type="button" aria-pressed={method === "chatgpt_subscription"} disabled={saving} onClick={() => setMethod("chatgpt_subscription")}>Subscription · BYOS</button> : null}</div>
        {method === "chatgpt_subscription" && provider === "openai" ? <AutomationSubscriptionConnect onConnected={connected} /> : <>
          <label className="automationModel__key"><span>API key</span><input ref={keyInput} type="password" autoComplete="off" placeholder="Enter API key" value={apiKey} disabled={saving} onChange={event => setApiKey(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (apiKey.trim() && !saving) void connect(); } }} /></label>
          <div className="automationModel__footer"><div>Usage is billed to your {providerName} account.</div>{error ? <p role="alert">{error}</p> : null}<button type="button" className="automationModel__save" disabled={saving || !apiKey.trim()} onClick={() => void connect()}>{saving ? "Connecting…" : "Connect"}</button></div>
        </>}
      </> : <>
        <div className="automationModel__menuHeading">Harnesses for {configuration.model}</div>
        {harnesses.filter(item => supportsAutomationHarness(configuration.modelProvider, item.id, subscriptionSelected)).map(item => <button type="button" role="menuitemradio" aria-checked={configuration.harness === item.id} className="automationModel__row" key={item.id} onClick={() => { onChange({ harness: item.id }); setPanel(null); harnessButton.current?.focus(); }}><span><span>{item.name}</span><small>{item.description}</small></span>{configuration.harness === item.id ? <CheckIcon size={14} /> : null}</button>)}
      </>}
    </div> : null}
  </div>;
}
