import { useEffect, useRef, useState } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { fetchAutomationCredentials, fetchAutomationModels, fetchIncludedAutomationModels, type AvailableAutomationModel, type AutomationConfiguration, type AutomationModelProvider } from "../automations-api";
import { chatGPTSubscription } from "../chatgpt-subscription";
import { automationModelProviders, supportsAutomationHarness } from "../../../../packages/core/src/automations/model-providers";
import { cn } from "@/lib/utils";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { searchInputProps } from "./search-input-props";
import "./automation-model-picker.css";

const harnesses = [
  { id: "codex" as const, name: "Codex", description: "Default coding harness" },
  { id: "claude_agent_sdk" as const, name: "Anthropic", description: "Anthropic agent harness" },
  { id: "opencode" as const, name: "OpenCode", description: "OpenCode agent harness" },
];
type Catalog = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; models: AvailableAutomationModel[]; subscription?: boolean };
function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : "Unable to load models."; }
async function loadCatalog(provider: AutomationModelProvider): Promise<Catalog> {
  const subscription = provider === "openai" ? chatGPTSubscription(await fetchAutomationCredentials()) : undefined;
  if (subscription) return { status: "ready", models: (await fetchAutomationModels(subscription.id)).models, subscription: true };
  return { status: "ready", models: (await fetchIncludedAutomationModels(provider)).models };
}
// Choosing a model needs no connection: runs use the organization's own key or
// subscription for the provider when one is connected, and included usage
// otherwise. With a ChatGPT subscription, OpenAI lists the models it serves.
// Each provider's models open in a submenu beside it.
export function AutomationModelPicker({ configuration, onChange, requestedOpen }: {
  configuration: AutomationConfiguration;
  onChange: (patch: Partial<AutomationConfiguration>) => void;
  requestedOpen: number;
}) {
  const [open, setOpen] = useState(false);
  const [catalogs, setCatalogs] = useState<Partial<Record<AutomationModelProvider, Catalog>>>({});
  // Radix keeps focus on menu rows, so typing and pointing are sent to the
  // open submenu's search field.
  const searchInputs = useRef(new Map<AutomationModelProvider, HTMLInputElement>());
  const focusSearch = (provider: AutomationModelProvider) => searchInputs.current.get(provider)?.focus();
  const [lastRequestedOpen, setLastRequestedOpen] = useState(requestedOpen);
  if (lastRequestedOpen !== requestedOpen) { setLastRequestedOpen(requestedOpen); setOpen(true); }
  // Load every provider's models up front so submenus open populated.
  useEffect(() => {
    let active = true;
    for (const { id } of automationModelProviders) {
      loadCatalog(id)
        .then(catalog => { if (active) setCatalogs(current => ({ ...current, [id]: catalog })); })
        .catch((cause: unknown) => { if (active) setCatalogs(current => ({ ...current, [id]: { status: "error", error: errorMessage(cause) } })); });
    }
    return () => { active = false; };
  }, []);
  function retry(provider: AutomationModelProvider) {
    setCatalogs(current => ({ ...current, [provider]: { status: "loading" } }));
    loadCatalog(provider)
      .then(catalog => setCatalogs(current => ({ ...current, [provider]: catalog })))
      .catch((cause: unknown) => setCatalogs(current => ({ ...current, [provider]: { status: "error", error: errorMessage(cause) } })));
  }
  function chooseModel(provider: AutomationModelProvider, model: AvailableAutomationModel) {
    // Only Codex runs use the ChatGPT subscription that serves these models.
    const subscription = catalogs[provider]?.status === "ready" && catalogs[provider].subscription;
    const harness = subscription ? "codex"
      : supportsAutomationHarness(provider, configuration.harness) ? configuration.harness
      : provider === "openai" ? "codex" : provider === "anthropic" ? "claude_agent_sdk" : "opencode";
    onChange({ modelProvider: provider, model: model.id, harness });
  }
  const selectedModel = configuration.model ? `${configuration.modelProvider}/${configuration.model}` : "";
  // The subscription's models run only on Codex, so the other harnesses are hidden.
  const providerCatalog = catalogs[configuration.modelProvider];
  const subscriptionModels = providerCatalog?.status === "ready" && providerCatalog.subscription === true;
  return <div className="automationModel">
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild><button className="automationModel__toggle" type="button">{configuration.model ? `Model: ${configuration.model}` : "Choose model"}<CaretDownIcon size={12} /></button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {automationModelProviders.map(provider => {
          const catalog = catalogs[provider.id];
          return <DropdownMenuSub key={provider.id}>
            <DropdownMenuSubTrigger onKeyDown={event => {
              if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || !searchInputs.current.has(provider.id)) return;
              event.stopPropagation();
              focusSearch(provider.id);
            }}><img className="size-4" src={`/model-providers/${provider.id}.svg`} alt="" aria-hidden="true" />{provider.name}</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="p-0" onPointerEnter={() => focusSearch(provider.id)} onFocus={event => { if (event.target === event.currentTarget) focusSearch(provider.id); }}>
                <Command>
                  <CommandInput {...searchInputProps} placeholder="Search models…" className="h-9"
                    ref={input => { if (input) searchInputs.current.set(provider.id, input); else searchInputs.current.delete(provider.id); }}
                    onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key) && event.currentTarget.value) event.stopPropagation(); }} />
                  <CommandList>
                    {catalog?.status === "ready" ? <>
                      <CommandEmpty>No models found.</CommandEmpty>
                      <CommandGroup heading={catalog.subscription ? "Your ChatGPT subscription" : undefined}>
                        {catalog.models.map(model => <CommandItem key={model.id} value={`${provider.id}/${model.id}`} keywords={[model.name]} onSelect={() => { chooseModel(provider.id, model); setOpen(false); }}>
                          {model.name}
                          <CheckIcon className={cn("ml-auto", selectedModel === `${provider.id}/${model.id}` ? "opacity-100" : "opacity-0")} />
                        </CommandItem>)}
                      </CommandGroup>
                    </> : catalog?.status === "error" ? <CommandGroup>
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">{catalog.error}</p>
                      <CommandItem onSelect={() => retry(provider.id)}>Retry</CommandItem>
                    </CommandGroup> : <p className="py-6 text-center text-sm text-muted-foreground">Loading models…</p>}
                  </CommandList>
                </Command>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
    <span className="automationCreate__divider" />
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button className="automationModel__toggle" type="button" disabled={!configuration.model}>Harness: {harnesses.find(item => item.id === configuration.harness)?.name}<CaretDownIcon size={12} /></button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="font-normal text-muted-foreground">Harnesses for {configuration.model}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={configuration.harness} onValueChange={value => onChange({ harness: value as AutomationConfiguration["harness"] })}>
          {harnesses.filter(item => supportsAutomationHarness(configuration.modelProvider, item.id) && (!subscriptionModels || item.id === "codex")).map(item => <DropdownMenuRadioItem key={item.id} value={item.id}>
            <div className="flex flex-col"><span>{item.name}</span><span className="text-xs text-muted-foreground">{item.description}</span></div>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
