import { useRef } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { slackTriggerFilters, type SlackTriggerFilter } from "../automation-configuration";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu";

const slackFilterLabels: Record<SlackTriggerFilter, string> = {
  ignoredAuthors: "Ignore messages from",
  ignoredPhrases: "Ignore messages matching",
  includedAuthors: "Only messages from",
};

// Adds or removes a Slack trigger's message filters. Author filters list who
// posted in the selected channels, so they wait for a channel.
export function SlackFilterMenu({ hasChannels, shown, onToggle }: {
  hasChannels: boolean;
  shown: SlackTriggerFilter[];
  onToggle: (filter: SlackTriggerFilter, shown: boolean) => void;
}) {
  // A filter just added takes focus, so it is added once the menu has
  // closed and released focus.
  const added = useRef<SlackTriggerFilter | null>(null);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button aria-label="Message filters" className="automationCreate__iconButton" type="button"><DotsThreeIcon size={16} weight="bold" /></button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" onCloseAutoFocus={(event) => {
      if (!added.current) return;
      event.preventDefault();
      onToggle(added.current, true);
      added.current = null;
    }}>
      {slackTriggerFilters.map((filter) => <DropdownMenuCheckboxItem
        checked={shown.includes(filter)}
        disabled={filter !== "ignoredPhrases" && !hasChannels && !shown.includes(filter)}
        key={filter}
        onCheckedChange={(checked) => {
          if (checked) added.current = filter;
          else onToggle(filter, false);
        }}
      >{slackFilterLabels[filter]}</DropdownMenuCheckboxItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
