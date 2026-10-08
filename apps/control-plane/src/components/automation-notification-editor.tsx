import { useRef, useState } from "react";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { AutomationNotification, AutomationOptions } from "../automations-api";
import { AutomationResourcePicker } from "./automation-resource-picker";
import { ProviderGlyph } from "./icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import "./automation-notification-editor.css";

// The server accepts up to ten notifications.
const maxNotifications = 10;

function channelKey(notification: Pick<AutomationNotification, "channelId" | "integrationAccountId">) {
  return `${notification.integrationAccountId}:${notification.channelId}`;
}

// Where a scheduled, Sentry, or Axiom automation posts each finished run.
// Slack only for now.
export function AutomationNotificationEditor({ notifications, onChange, onRefresh, options }: {
  notifications: AutomationNotification[];
  onChange: (notifications: AutomationNotification[]) => void;
  onRefresh: () => Promise<void>;
  options: AutomationOptions | null;
}) {
  // A new notification waits for its channel before it is saved.
  const [adding, setAdding] = useState(false);
  const openingPicker = useRef(false);
  const slackAccounts = options?.accounts.filter((account) => account.provider === "slack") ?? [];
  const channels = (options?.resources ?? [])
    .filter((resource) => resource.kind === "slack_channel" && slackAccounts.some((account) => account.id === resource.integrationAccountId))
    .map((resource) => ({
      channelId: resource.externalId,
      integrationAccountId: resource.integrationAccountId,
      // A workspace name tells channels apart when several are connected.
      label: `#${resource.displayName}${slackAccounts.length > 1 ? ` · ${slackAccounts.find((account) => account.id === resource.integrationAccountId)?.displayName ?? ""}` : ""}`,
    }));
  const used = new Set(notifications.map(channelKey));
  // The picker keys channels by connection and channel, since a channel ID is
  // only unique within its Slack workspace.
  const choices = (current?: string) => channels
    .filter((channel) => channelKey(channel) === current || !used.has(channelKey(channel)))
    .map((channel) => ({ displayName: channel.label, externalId: channelKey(channel) }));
  const channelFor = (key: string | undefined) => channels.find((channel) => channelKey(channel) === key);

  return <section aria-labelledby="automation-notifications" className="automationCreate__section">
    <div className="automationNotifications__header">
      <div>
        <h2 id="automation-notifications">Notifications</h2>
        <p className="automationNotifications__description">Post each finished run</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="automationCreate__secondary" disabled={notifications.length >= maxNotifications} type="button"><PlusIcon size={14} />Add notification</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={(event) => {
          // The menu keeps focus until it has closed, so the new row's channel
          // picker opens then and takes focus instead of this button.
          if (!openingPicker.current) return;
          openingPicker.current = false;
          event.preventDefault();
          setAdding(true);
        }}>
          <DropdownMenuItem disabled={!slackAccounts.length} onSelect={() => { openingPicker.current = true; }}>
            <ProviderGlyph decorative provider="slack" />{slackAccounts.length ? "Post to Slack" : "Post to Slack (connect Slack in Settings first)"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {notifications.length || adding ? <div className="automationCreate__rows">
      {notifications.map((notification, index) => {
        const key = channelKey(notification);
        return <div className="automationCreate__row automationNotifications__row" key={key}>
          <ProviderGlyph decorative provider="slack" />
          <span className="automationNotifications__title">Post to Slack</span>
          <span className="automationNotifications__hint">Post the agent's response to</span>
          <AutomationResourcePicker hideLabel label="Channel" onChange={([next]) => {
            const channel = channelFor(next);
            if (channel) onChange(notifications.map((item, position) => position === index ? { ...item, channelId: channel.channelId, integrationAccountId: channel.integrationAccountId } : item));
          }} onRefresh={onRefresh} resources={choices(key)} selected={[key]} single />
          <button aria-label={`Remove notification to ${channelFor(key)?.label ?? "Slack"}`} className="automationCreate__iconButton" onClick={() => onChange(notifications.filter((_, position) => position !== index))} type="button"><TrashIcon size={14} /></button>
        </div>;
      })}
      {adding ? <div className="automationCreate__row automationNotifications__row">
        <ProviderGlyph decorative provider="slack" />
        <span className="automationNotifications__title">Post to Slack</span>
        <span className="automationNotifications__hint">Post the agent's response to</span>
        <AutomationResourcePicker defaultOpen hideLabel label="Channel" onChange={([next]) => {
          const channel = channelFor(next);
          if (channel) onChange([...notifications, { channelId: channel.channelId, integrationAccountId: channel.integrationAccountId, kind: "slack" }]);
        }} onClose={() => setAdding(false)} onRefresh={onRefresh} resources={choices()} selected={[]} single />
        <button aria-label="Cancel notification" className="automationCreate__iconButton" onClick={() => setAdding(false)} type="button"><TrashIcon size={14} /></button>
      </div> : null}
    </div> : null}
  </section>;
}
