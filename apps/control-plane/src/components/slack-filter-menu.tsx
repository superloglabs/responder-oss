import { useRef } from "react";
import { CheckIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { slackTriggerFilters, type SlackTriggerFilter } from "../automation-configuration";
import { IconButton } from "../design-system";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

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
      <IconButton aria-label="Message filters" size="small" variant="ghost">
        <DotsThreeIcon size={16} weight="bold" />
      </IconButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" onCloseAutoFocus={(event) => {
      if (!added.current) return;
      event.preventDefault();
      onToggle(added.current, true);
      added.current = null;
    }}>
      {slackTriggerFilters.map((filter) => {
        const active = shown.includes(filter);
        return <DropdownMenuItem
          disabled={filter !== "ignoredPhrases" && !hasChannels && !active}
          key={filter}
          onSelect={() => {
            if (active) onToggle(filter, false);
            else added.current = filter;
          }}
        >
          {slackFilterLabels[filter]}
          {active ? <CheckIcon aria-label="On" className="ml-auto" size={14} /> : null}
        </DropdownMenuItem>;
      })}
    </DropdownMenuContent>
  </DropdownMenu>;
}
