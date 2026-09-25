import { CheckIcon, KeyIcon, PlusIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { AutomationOptions } from "../automations-api";
import { automationConnectorProviders, type AutomationConnectorProvider } from "./automation-connectors";
import { ProviderGlyph } from "./icons";
import { providerDisplayName } from "./provider-glyphs";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { searchInputProps } from "./search-input-props";

// Lists every connector. Connections already in the workspace are added to the
// draft; the rest start a connection, after which the page adds them.
export function AutomationConnectorPicker({ options, triggerAccountIds, selectedAccountIds, selectedSecretIds, githubIncluded, onToggleAccount, onToggleSecret, onToggleGithub, onConnect }: {
  options: AutomationOptions | null;
  triggerAccountIds: string[];
  selectedAccountIds: string[];
  selectedSecretIds: string[];
  githubIncluded: boolean;
  onToggleAccount: (accountId: string) => void;
  onToggleSecret: (secretId: string) => void;
  onToggleGithub: () => void;
  onConnect: (provider: AutomationConnectorProvider) => void;
}) {
  const accounts = options?.accounts ?? [];
  const check = (selected: boolean) => <CheckIcon className={cn("ml-auto", selected ? "opacity-100" : "opacity-0")} />;
  return <Popover>
    <PopoverTrigger asChild><button className="automationCreate__add" disabled={!options} type="button"><PlusIcon size={16} />Add connector</button></PopoverTrigger>
    <PopoverContent align="start" className="w-80 p-0">
      <Command>
        <CommandInput {...searchInputProps} placeholder="Search connectors…" className="h-9" />
        <CommandList>
          <CommandEmpty>No connectors found.</CommandEmpty>
          <CommandGroup heading="Connectors">
            {automationConnectorProviders.flatMap(provider => {
              const name = providerDisplayName(provider);
              const connected = accounts.filter(account => account.provider === provider);
              const glyph = <ProviderGlyph decorative provider={provider} />;
              if (provider === "github" && connected.length) {
                return [<CommandItem key="github" value="github" keywords={[name]} onSelect={onToggleGithub}>{glyph}{name}{check(githubIncluded)}</CommandItem>];
              }
              const items = provider === "github" ? [] : connected.map(account => triggerAccountIds.includes(account.id)
                ? <CommandItem key={account.id} value={account.id} keywords={[account.displayName, name]} disabled>{glyph}<span className="truncate">{account.displayName}</span><span className="ml-auto text-xs text-muted-foreground">Trigger</span></CommandItem>
                : <CommandItem key={account.id} value={account.id} keywords={[account.displayName, name]} onSelect={() => onToggleAccount(account.id)}>{glyph}<span className="truncate">{account.displayName}</span><span className="text-xs text-muted-foreground">{name}</span>{check(selectedAccountIds.includes(account.id))}</CommandItem>);
              // Custom MCP can have several servers, so it can always add another.
              if (!connected.length || provider === "custom_mcp") {
                items.push(<CommandItem key={`connect-${provider}`} value={`connect-${provider}`} keywords={[name, "connect"]} onSelect={() => onConnect(provider)}>{glyph}{provider === "custom_mcp" ? "Add custom MCP server" : `Connect ${name}`}<span className="ml-auto text-xs text-muted-foreground">Connect</span></CommandItem>);
              }
              return items;
            })}
          </CommandGroup>
          {options?.secrets.length ? <CommandGroup heading="Workspace secrets">
            {options.secrets.map(secret => <CommandItem key={secret.id} value={secret.id} keywords={[secret.name, "secret"]} onSelect={() => onToggleSecret(secret.id)}><KeyIcon />{secret.name}{check(selectedSecretIds.includes(secret.id))}</CommandItem>)}
          </CommandGroup> : null}
        </CommandList>
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">Runs use selected connectors directly. Write actions run without human approval.</p>
      </Command>
    </PopoverContent>
  </Popover>;
}
