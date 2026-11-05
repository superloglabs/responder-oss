import { useCallback, useEffect, useId, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { BellIcon, CheckIcon, CaretDownIcon } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import type { ErrorNotificationSettings, ErrorNotificationTarget } from "../../../../packages/core/src/telemetry/error-notifications";
import type { TelemetryAlertSlackChannel } from "../../../../packages/core/src/db/telemetry-alerts";
import type { ClaudeRoutine } from "../../../../packages/core/src/db/claude-routines";
import { Button, SelectField, Switch } from "../design-system";
import { DashboardDialog } from "./dashboard-dialog";
import "./dashboards.css";
import "./error-notification-settings.css";
import { apiErrorMessage } from "../agents-api";

type Configuration = {
  settings: ErrorNotificationSettings;
  channels: TelemetryAlertSlackChannel[];
  routines: ClaudeRoutine[];
};
// The settings with the destination of one kind replaced, or removed.
function withTarget(settings: ErrorNotificationSettings, kind: ErrorNotificationTarget["kind"], target: ErrorNotificationTarget | null): ErrorNotificationSettings {
  return { ...settings, targets: [...settings.targets.filter((item) => item.kind !== kind), ...(target ? [target] : [])] };
}
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
  const channelInputId = useId();
  const [portalContainer, setPortalContainer] = useState<HTMLDialogElement | null>(null);
  const attachDestination = useCallback((node: HTMLDivElement | null) => { setPortalContainer(node?.closest("dialog") ?? null); }, []);
  const target = settings?.targets.find((item) => item.kind === "slack");
  const routineId = settings?.targets.find((item) => item.kind === "claude_routine")?.routineId ?? "";
  const selectedChannel = configuration?.channels.find((channel) => channel.integrationAccountId === target?.integrationAccountId && channel.channelId === target?.channelId);
  const routineOptions = [
    { label: "Don't start a routine", value: "" },
    ...(configuration?.routines ?? []).map((routine) => ({ label: routine.name, value: routine.id })),
    ...(routineId && !configuration?.routines.some((routine) => routine.id === routineId) ? [{ label: "A routine that was removed", value: routineId }] : []),
  ];
  return <DashboardDialog title="Error notifications" onClose={() => { if (!saving) onClose(); }} actions={<>
    <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={!settings || saving || (settings.enabled && settings.targets.length === 0)} onClick={() => void save()}>{saving ? "Saving…" : "Save notifications"}</Button>
  </>}>
    <p className="errorNotifications__description">Notify your team when a new error appears or a resolved error happens again.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!configuration && !error ? <p role="status">Loading notifications…</p> : null}
    {settings && configuration ? <fieldset className="errorNotifications" disabled={saving}>
      <div className="errorNotifications__toggle">
        <span className="errorNotifications__provider"><BellIcon size={22} aria-hidden="true" /></span>
        <Switch label="Enable error notifications" checked={settings.enabled} onCheckedChange={(enabled) => setSettings({ ...settings, enabled })} />
      </div>
      <div className="errorNotifications__destination" ref={attachDestination}>
        <div className="errorNotifications__label">
          <label htmlFor={channelInputId}>Slack channel</label>
          <span>{selectedChannel ? `Sending to #${selectedChannel.name}` : "Choose one channel"}</span>
        </div>
        {configuration.channels.length ? <Combobox.Root
          items={configuration.channels}
          value={selectedChannel ?? null}
          disabled={saving}
          modal={false}
          itemToStringLabel={(channel) => `${channel.name} (${channel.accountName})`}
          isItemEqualToValue={(channel, value) => channel.integrationAccountId === value.integrationAccountId && channel.channelId === value.channelId}
          filter={(channel, search) => {
            const query = search.trim().replace(/^#/, "").toLocaleLowerCase();
            return [channel.name, channel.accountName].some((value) => value.toLocaleLowerCase().includes(query));
          }}
          onValueChange={(channel) => setSettings(withTarget(settings, "slack", channel ? { kind: "slack", integrationAccountId: channel.integrationAccountId, channelId: channel.channelId } : null))}
        >
          <Combobox.InputGroup className="errorChannelPicker__search">
            <Combobox.Input id={channelInputId} placeholder="Choose a channel…" />
            <Combobox.Trigger className="errorChannelPicker__trigger" aria-label="Show Slack channels">
              <CaretDownIcon size={14} aria-hidden="true" />
            </Combobox.Trigger>
          </Combobox.InputGroup>
          {/* Stay inside the native dialog's top layer; fixed positioning escapes its scrolling body. */}
          <Combobox.Portal container={portalContainer}>
            <Combobox.Positioner className="errorChannelPicker__positioner" positionMethod="fixed" sideOffset={4} align="start" collisionBoundary={[]}>
              <Combobox.Popup className="errorChannelPicker__popup">
                <Combobox.Empty className="errorChannelPicker__empty">No channels found. Try another name or workspace.</Combobox.Empty>
                <Combobox.List className="errorChannelPicker__list" aria-label="Slack channels">
                  {(channel: TelemetryAlertSlackChannel) => <Combobox.Item key={`${channel.integrationAccountId}:${channel.channelId}`} value={channel} className="errorChannelPicker__option">
                    <span className="errorChannelPicker__copy"><span>{channel.name}</span><small>{channel.accountName}{channel.private ? " · Private channel" : ""}</small></span>
                    <Combobox.ItemIndicator><CheckIcon size={18} aria-label="Selected destination" /></Combobox.ItemIndicator>
                  </Combobox.Item>}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Positioner>
          </Combobox.Portal>
        </Combobox.Root> : <div className="errorChannelPicker__emptyState">
          <strong>No Slack channels available</strong>
          <p>Connect a Slack workspace or check channel access in <Link to="/settings">Integrations</Link>.</p>
        </div>}
        <p className="errorNotifications__hint">{settings.enabled ? "New and recurring errors will be sent to this channel." : "Notifications are paused. Your channel selection will be saved."}</p>
      </div>
      <div className="errorNotifications__destination">
        <SelectField
          label="Claude routine"
          onChange={(value) => setSettings(withTarget(settings, "claude_routine", value ? { kind: "claude_routine", routineId: value } : null))}
          options={routineOptions}
          value={routineId}
        />
        <p className="errorNotifications__hint">
          {configuration.routines.length
            ? "Starts one session for each new or recurring error, with the error's details."
            : <>Add a Claude Code routine in <Link to="/settings/claude-routines">Settings</Link> to start it for new and recurring errors.</>}
        </p>
      </div>
      <div className="errorNotifications__toggle">
        <Switch label="Only exceptions" checked={settings.exceptionsOnly ?? false} onCheckedChange={(exceptionsOnly) => setSettings({ ...settings, exceptionsOnly })} />
      </div>
      <p className="errorNotifications__hint">Skips plain error log lines. They stay on the Errors page.</p>
    </fieldset> : null}
  </DashboardDialog>;
}
