import { useState, type ReactNode } from "react";
import { IconCheck } from "@tabler/icons-react";
import { refreshSlackAgentOptions, type AgentOptions } from "../agents-api";
import { Button } from "../design-system";
import { DiscordWebhook, RowError } from "./discord";
import type { FindingsDestination } from "./destination-model";
import type { SignalSettings } from "./model";
import { slackChannels, type SourceActions } from "./setup-data";
import { ChannelSelect } from "./setup-shared";
import { SettingsRow, SignalLogo } from "./shared";

// Setup's question of where findings go: Slack or Discord, one at a time.
// The chosen option opens its own setup; the other stays one line.
export function FindingsDestinationPicker({ choice, onChoose, actions, options, onOptions, draft, onDraft, onDiscordSaved, slackFailure }: {
  choice: FindingsDestination | null;
  onChoose: (choice: FindingsDestination) => void;
  actions: SourceActions;
  options: AgentOptions;
  onOptions: (options: AgentOptions) => void;
  draft: SignalSettings;
  onDraft: (draft: SignalSettings) => void;
  onDiscordSaved: (settings: SignalSettings) => void;
  // Why Slack's sign-in failed, when it just sent the person back.
  slackFailure: string | null;
}) {
  return <div className="signalDestinations" role="radiogroup" aria-label="Where Signal posts findings">
    <Option provider="slack" name="Slack" selected={choice === "slack"} onSelect={() => onChoose("slack")}
      description="Post each finding to a channel, with Helpful, Jira, and coding agent buttons.">
      <SlackDetails actions={actions} options={options} onOptions={onOptions} draft={draft} onDraft={onDraft} failure={slackFailure} />
    </Option>
    <Option provider="discord" name="Discord" selected={choice === "discord"} onSelect={() => onChoose("discord")}
      description="Post each finding to a channel through a webhook. Actions stay on the finding's page.">
      <div className="signalDestination__details">
        <DiscordWebhook label="Webhook" connected={draft.discord.connected} delivery={draft.delivery}
          connectedDescription="We posted a test message to the channel. Findings go there from now on."
          onSaved={onDiscordSaved} />
      </div>
    </Option>
  </div>;
}

function Option({ provider, name, description, selected, onSelect, children }: {
  provider: string;
  name: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return <div className={`signalDestination${selected ? " signalDestination--selected" : ""}`}>
    <button type="button" role="radio" aria-checked={selected} className="signalDestination__option" onClick={onSelect}>
      <span className="signalRadio" aria-hidden="true" />
      <span className="signalLogoSlot"><SignalLogo provider={provider} /></span>
      <span className="signalDestination__label"><strong>{name}</strong><span>{description}</span></span>
    </button>
    {selected && children}
  </div>;
}

function SlackDetails({ actions, options, onOptions, draft, onDraft, failure }: {
  actions: SourceActions;
  options: AgentOptions;
  onOptions: (options: AgentOptions) => void;
  draft: SignalSettings;
  onDraft: (draft: SignalSettings) => void;
  failure: string | null;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const connected = actions.connected("slack");
  const workspace = actions.accounts("slack").map((account) => account.displayName).join(", ");
  const hasChannels = slackChannels(options).length > 0;

  async function refresh() {
    setRefreshing(true);
    setRefreshError(false);
    try {
      onOptions(await refreshSlackAgentOptions());
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  }

  return <div className="signalDestination__details">
    <SettingsRow label="Workspace"
      description={failure && !connected ? <RowError>{failure}</RowError>
        : connected ? workspace || "Connected" : "Connect the Slack workspace findings go to."}>
      <span className="signalRowActions">
        {connected && <span className="signalConnected"><IconCheck aria-hidden="true" size={14} />Connected</span>}
        {connected
          ? <Button onClick={() => actions.manage("slack")}>Change workspace</Button>
          : <Button variant="primary" disabled={!actions.summary("slack")?.connectUrl} onClick={() => actions.connect("slack")}>Connect Slack</Button>}
      </span>
    </SettingsRow>
    {connected && <SettingsRow label="Findings channel"
      description={refreshError ? <RowError>Could not reload Slack's channels. Try again.</RowError>
        : hasChannels ? "Findings are posted here."
        : <RowError>The Slack app is not in any channel yet. In Slack, open the channel and invite the app, then refresh.</RowError>}>
      {hasChannels
        ? <ChannelSelect options={options} value={draft.slack} onChange={(slack) => onDraft({ ...draft, slack })} />
        : <Button loading={refreshing} disabled={refreshing} onClick={() => void refresh()}>Refresh channels</Button>}
    </SettingsRow>}
  </div>;
}
