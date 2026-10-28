import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { CheckIcon, MagnifyingGlassIcon, SlackLogoIcon } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import type { ErrorNotificationSettings } from "../../../../packages/core/src/telemetry/error-notifications";
import type { TelemetryAlertSlackChannel } from "../../../../packages/core/src/db/telemetry-alerts";
import { Button, Switch } from "../design-system";
import { DashboardDialog } from "./dashboard-dialog";
import "./dashboards.css";
import "./error-notification-settings.css";
import { apiErrorMessage } from "../agents-api";

type Configuration = {
  settings: ErrorNotificationSettings;
  channels: TelemetryAlertSlackChannel[];
};
async function request<T>(method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("/api/error-notifications", { method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiErrorMessage(result, response.status));
  return result as T;
}
export function ErrorNotificationSettingsDialog({ onClose }: { onClose: () => void }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [settings, setSettings] = useState<ErrorNotificationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void request<Configuration>().then((value) => {
      if (!active) return;
      setConfiguration(value); setSettings(value.settings);
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load notifications"); });
    return () => { active = false; };
  }, []);
  async function save() {
    if (!settings) return;
    setSaving(true); setError(null);
    try {
      await request("PUT", settings);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save notifications"); }
    finally { setSaving(false); }
  }
  const target = settings?.targets[0];
  const selectedChannel = configuration?.channels.find((channel) => channel.integrationAccountId === target?.integrationAccountId && channel.channelId === target?.channelId);
  return <DashboardDialog title="Error notifications" onClose={() => { if (!saving) onClose(); }} actions={<>
    <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={!settings || saving || (settings.enabled && !target)} onClick={() => void save()}>{saving ? "Saving…" : "Save notifications"}</Button>
  </>}>
    <p className="errorNotifications__description">Notify your team when a new error appears or a resolved error happens again.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!configuration && !error ? <p role="status">Loading notifications…</p> : null}
    {settings && configuration ? <fieldset className="errorNotifications" disabled={saving}>
      <div className="errorNotifications__toggle">
        <span className="errorNotifications__provider"><SlackLogoIcon size={22} aria-hidden="true" /></span>
        <Switch label="Enable error notifications" checked={settings.enabled} onCheckedChange={(enabled) => setSettings({ ...settings, enabled })} />
      </div>
      <div className="errorNotifications__destination">
        <div className="errorNotifications__label">
          <span>Slack channel</span>
          <span>{selectedChannel ? `Sending to #${selectedChannel.name}` : "Choose one channel"}</span>
        </div>
        {configuration.channels.length ? <Command className="errorChannelPicker" label="Search Slack channels" filter={(_value, search, keywords) => {
          const query = search.trim().replace(/^#/, "").toLocaleLowerCase();
          return keywords?.some((keyword) => keyword.toLocaleLowerCase().includes(query)) ? 1 : 0;
        }}>
          <div className="errorChannelPicker__search">
            <MagnifyingGlassIcon size={14} aria-hidden="true" />
            <Command.Input aria-label="Search Slack channels" placeholder="Search channels or workspaces…" disabled={saving} />
          </div>
          <Command.List className="errorChannelPicker__list" label="Slack channels">
            <Command.Empty className="errorChannelPicker__empty">No channels found. Try another name or workspace.</Command.Empty>
            {configuration.channels.map((channel) => {
              const selected = channel.integrationAccountId === target?.integrationAccountId && channel.channelId === target?.channelId;
              return <Command.Item key={`${channel.integrationAccountId}:${channel.channelId}`} value={`${channel.integrationAccountId}:${channel.channelId}`} keywords={[channel.name, channel.accountName]} disabled={saving} className="errorChannelPicker__option" onSelect={() => {
                setSettings({ ...settings, targets: [{ kind: "slack", integrationAccountId: channel.integrationAccountId, channelId: channel.channelId }] });
              }}>
                <span className="errorChannelPicker__copy"><span>{channel.name}</span><small>{channel.accountName}{channel.private ? " · Private channel" : ""}</small></span>
                {selected ? <CheckIcon size={18} aria-label="Selected destination" /> : null}
              </Command.Item>;
            })}
          </Command.List>
        </Command> : <div className="errorChannelPicker__emptyState">
          <strong>No Slack channels available</strong>
          <p>Connect a Slack workspace or check channel access in <Link to="/settings">Integrations</Link>.</p>
        </div>}
        <p className="errorNotifications__hint">{settings.enabled ? "New and recurring errors will be sent to this channel." : "Notifications are paused. Your channel selection will be saved."}</p>
      </div>
    </fieldset> : null}
  </DashboardDialog>;
}
