import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Combobox } from "@base-ui/react/combobox";
import { IconCheck, IconChevronDown, IconSearch } from "@tabler/icons-react";
import type { AgentOptions } from "../agents-api";
import { ScrollArea } from "../components/ui/scroll-area";
import { SignalConnect } from "./connect";
import type { ConnectPage } from "./connect-pages";
import { SignalManage } from "./manage";
import { slackChannels, sourceName, type Source, type SourceActions } from "./setup-data";
import { ConnectionRow } from "./shared";

export function SourceRows({ sources, actions, otelServices }: {
  sources: Source[];
  actions: SourceActions;
  otelServices: number | null;
}) {
  return <div className="signalConnections signalConnections--compact">{sources.map((source) => <ConnectionRow key={source.provider}
    provider={source.provider}
    name={source.name}
    description={source.provider === "jira" ? "Coming soon"
      : source.provider === "otel" && otelServices ? `${otelServices} ${otelServices === 1 ? "service" : "services"} sending data`
      : source.description}
    connected={actions.connected(source.provider)}
    disabled={actions.unavailable(source.provider)}
    onConnect={() => actions.connect(source.provider)}
    onManage={() => actions.manage(source.provider)} />)}
  </div>;
}

// A source's own page under a list: its manage page once connected, and
// the connect form until then or with `mode` "connect", to replace keys or
// sign in again.
export function SourcePage({ page, mode, actions, otel, organizationId, onChanged }: {
  page: ConnectPage;
  mode: string | undefined;
  actions: SourceActions;
  otel: { count: number | null; failed: boolean };
  organizationId: string | undefined;
  // A connection was added or removed; `removed` shows loading meanwhile.
  onChanged: (removed: boolean) => void;
}) {
  const navigate = useNavigate();
  const { listPath } = actions;
  if (page === "otel" && mode !== "connect" && otel.count === null) return <p className="signalLoading" role="status">Loading…</p>;
  const managed = mode !== "connect" && (page === "otel" ? Boolean(otel.count) || otel.failed : actions.accounts(page).length > 0);
  if (managed) {
    return <SignalManage page={page}
      name={sourceName(page)}
      integration={actions.summary(page)}
      onBack={() => navigate(listPath)}
      onReconnect={() => navigate(`${listPath}/${page}/connect`)}
      onOpenIngestKeys={() => navigate("/settings/ingest-keys")}
      onRemoved={() => {
        onChanged(true);
        navigate(listPath);
      }} />;
  }
  return <SignalConnect page={page}
    integration={actions.summary(page)}
    organizationId={organizationId}
    listPath={listPath}
    onBack={() => navigate(listPath)}
    onDone={() => {
      onChanged(false);
      navigate(listPath);
    }} />;
}

export function RepositoryPicker({ repositories, selected, onChange, empty }: {
  repositories: AgentOptions["repositories"];
  selected: string[];
  onChange: (selected: string[]) => void;
  // Shown when GitHub has no repositories to choose from.
  empty: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const matches = repositories
    .filter((repository) => repository.fullName.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return <div className="signalRepositories">
    <div className="signalRepoSearch">
      <label className="signalSearch"><IconSearch size={14} /><input aria-label="Search repositories" placeholder="Search repositories…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <span>{selected.length} selected</span>
    </div>
    <ScrollArea className="signalRepoList">
      {matches.map((repository) => <label className="signalRepoRow" key={repository.id}>
        <span className="signalRepoCheckbox">
          <input type="checkbox" checked={selected.includes(repository.id)} onChange={(e) => onChange(e.target.checked
            ? [...selected, repository.id]
            : selected.filter((id) => id !== repository.id))} />
          <IconCheck aria-hidden="true" size={12} />
        </span>
        <span>{repository.fullName.replace("/", " / ")}</span>
      </label>)}
      {repositories.length === 0 && <p className="signalEmpty">{empty}</p>}
      {repositories.length > 0 && matches.length === 0 && <p className="signalEmpty">No repositories match “{search}”.</p>}
    </ScrollArea>
  </div>;
}

const channelName = (displayName: string) => displayName.replace(/^#/u, "");

// A searchable list of the workspace's Slack channels. Typing filters them;
// a leading "#" is ignored.
export function ChannelSelect({ options, value, onChange, disabled = false, className }: {
  options: AgentOptions;
  className?: string;
  value: { integrationAccountId: string; channelId: string } | null;
  onChange: (slack: { integrationAccountId: string; channelId: string } | null) => void;
  disabled?: boolean;
}) {
  const channels = slackChannels(options);
  const slack = options.accounts.some((account) => account.provider === "slack");
  return <div className="signalChannelField">
    <Combobox.Root
      items={channels}
      value={channels.find((channel) => channel.integrationAccountId === value?.integrationAccountId && channel.externalId === value?.channelId) ?? null}
      disabled={disabled || channels.length === 0}
      modal={false}
      itemToStringLabel={(channel) => channelName(channel.displayName)}
      isItemEqualToValue={(channel, selected) => channel.id === selected.id}
      filter={(channel, query) => channelName(channel.displayName).toLocaleLowerCase().includes(query.trim().replace(/^#/u, "").toLocaleLowerCase())}
      onValueChange={(channel) => onChange(channel ? { integrationAccountId: channel.integrationAccountId, channelId: channel.externalId } : null)}
    >
      <Combobox.InputGroup className={["signalChannelPicker", className].filter(Boolean).join(" ")}>
        <span aria-hidden="true">#</span>
        <Combobox.Input id="signal-findings-channel" aria-label="Findings channel" placeholder={channels.length ? "Choose a channel" : "No channels found"} />
        <Combobox.Trigger className="signalChannelPicker__trigger" aria-label="Show Slack channels">
          <IconChevronDown aria-hidden="true" size={14} />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="signalChannelPicker__positioner" sideOffset={4} align="start">
          <Combobox.Popup className="signalChannelPicker__popup">
            <Combobox.Empty className="signalChannelPicker__empty">No channels match.</Combobox.Empty>
            <Combobox.List className="signalChannelPicker__list" aria-label="Slack channels">
              {(channel: (typeof channels)[number]) => <Combobox.Item key={channel.id} value={channel} className="signalChannelPicker__option">
                <span># {channelName(channel.displayName)}</span>
                <Combobox.ItemIndicator><IconCheck aria-hidden="true" size={14} /></Combobox.ItemIndicator>
              </Combobox.Item>}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
    {channels.length === 0 && <p className="signalChannelHint">
      {slack ? "Invite Responder to a channel, then reload this page." : "Connect Slack to choose a channel."}
    </p>}
  </div>;
}
