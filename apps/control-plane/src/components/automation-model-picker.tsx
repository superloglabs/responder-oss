import { useEffect, useRef, useState } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { fetchIncludedAutomationModels, type AvailableAutomationModel, type AutomationConfiguration, type AutomationOptions, type AutomationModelProvider } from "../automations-api";
import { automationModelProviders, supportsAutomationHarness } from "../../../../packages/core/src/automations/model-providers";
import { cn } from "@/lib/utils";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./ui/dropdown-menu";
import "./automation-model-picker.css";

const harnesses = [
  { id: "codex" as const, name: "Codex", description: "Default coding harness" },
  { id: "claude_agent_sdk" as const, name: "Anthropic", description: "Anthropic agent harness" },
  { id: "opencode" as const, name: "OpenCode", description: "OpenCode agent harness" },
];
type Catalog = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; models: AvailableAutomationModel[] };
function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : "Unable to load models."; }
// Models run on included usage billed through Responder, so choosing one needs
// no connection. Each provider's models open in a submenu beside it.
export function AutomationModelPicker({ configuration, options, onChange, requestedOpen }: {
  configuration: AutomationConfiguration;
  options: AutomationOptions | null;
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
      fetchIncludedAutomationModels(id)
        .then(result => { if (active) setCatalogs(current => ({ ...current, [id]: { status: "ready", models: result.models } })); })
        .catch((cause: unknown) => { if (active) setCatalogs(current => ({ ...current, [id]: { status: "error", error: errorMessage(cause) } })); });
    }
    return () => { active = false; };
  }, []);
  function retry(provider: AutomationModelProvider) {
    setCatalogs(current => ({ ...current, [provider]: { status: "loading" } }));
    fetchIncludedAutomationModels(provider)
      .then(result => setCatalogs(current => ({ ...current, [provider]: { status: "ready", models: result.models } })))
      .catch((cause: unknown) => setCatalogs(current => ({ ...current, [provider]: { status: "error", error: errorMessage(cause) } })));
  }
  function chooseModel(provider: AutomationModelProvider, model: AvailableAutomationModel) {
    const harness = supportsAutomationHarness(provider, configuration.harness) ? configuration.harness
      : provider === "openai" ? "codex" : provider === "anthropic" ? "claude_agent_sdk" : "opencode";
    onChange({ modelProvider: provider, model: model.id, modelCredentialId: null, harness });
  }
  const subscriptionSelected = options?.credentials.some(item => item.id === configuration.modelCredentialId && item.authType === "chatgpt_subscription") ?? false;
  const selectedModel = configuration.model ? `${configuration.modelProvider}/${configuration.model}` : "";
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
                  <CommandInput placeholder="Search models…" className="h-9"
                    ref={input => { if (input) searchInputs.current.set(provider.id, input); else searchInputs.current.delete(provider.id); }}
                    onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key) && event.currentTarget.value) event.stopPropagation(); }} />
                  <CommandList>
                    {catalog?.status === "ready" ? <>
                      <CommandEmpty>No models found.</CommandEmpty>
                      <CommandGroup>
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
          {harnesses.filter(item => supportsAutomationHarness(configuration.modelProvider, item.id, subscriptionSelected)).map(item => <DropdownMenuRadioItem key={item.id} value={item.id}>
            <div className="flex flex-col"><span>{item.name}</span><span className="text-xs text-muted-foreground">{item.description}</span></div>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
