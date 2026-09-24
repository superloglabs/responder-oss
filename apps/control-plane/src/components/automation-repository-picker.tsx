import { GithubLogoIcon, PlusIcon } from "@phosphor-icons/react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AutomationOptions } from "../automations-api";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { useIntegrationConnect } from "./use-integration-connect";

const repositoryLimit = 10;

// Offers to connect GitHub until it is connected, then a searchable list of
// its synced repositories. The list stays open so several can be chosen.
export function AutomationRepositoryPicker({ options, selectedIds, onToggle, open, onOpenChange, onGithubConnected }: {
  options: AutomationOptions | null;
  selectedIds: string[];
  onToggle: (repositoryId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGithubConnected: (kind: "github", signal: AbortSignal) => Promise<boolean>;
}) {
  const { connect, connecting, error } = useIntegrationConnect("github", "GitHub", onGithubConnected);
  if (!options?.accounts.some(account => account.provider === "github")) {
    return <div className="automationTrigger__connectAction">
      <button className="automationCreate__add" disabled={connecting || !options} onClick={() => void connect()} type="button"><GithubLogoIcon size={16} />{connecting ? "Connecting GitHub…" : "Add GitHub"}</button>
      {error ? <p className="automationTrigger__connectError" role="alert">{error}</p> : null}
    </div>;
  }
  const atLimit = selectedIds.length >= repositoryLimit;
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild><button className="automationCreate__add" type="button"><PlusIcon size={16} />Add repository</button></PopoverTrigger>
    <PopoverContent align="start" className="w-80 p-0">
      <Command>
        <CommandInput placeholder="Search repositories…" className="h-9" />
        <CommandList>
          <CommandEmpty>No repositories found.</CommandEmpty>
          <CommandGroup heading={atLimit ? `Up to ${repositoryLimit} repositories` : undefined}>
            {options.repositories.map(repository => {
              const selected = selectedIds.includes(repository.id);
              return <CommandItem key={repository.id} value={repository.fullName} disabled={!selected && atLimit} onSelect={() => onToggle(repository.id)}>
                <GithubLogoIcon />
                {repository.fullName}
                <CheckIcon className={cn("ml-auto", selected ? "opacity-100" : "opacity-0")} />
              </CommandItem>;
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}
