import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { errorNotificationTargetKey, type ErrorNotificationSettings, type ErrorNotificationTarget } from "../../../../packages/core/src/telemetry/error-notifications";
import type { TelemetryAlertSlackChannel } from "../../../../packages/core/src/db/telemetry-alerts";
import { Button, Checkbox, SelectField, TextField } from "../design-system";
import { DashboardDialog } from "./dashboard-dialog";
import "./dashboards.css";
import { apiErrorMessage } from "../agents-api";

type Configuration = {
  settings: ErrorNotificationSettings;
  members: Array<{ id: string; name: string; email: string }>;
  channels: TelemetryAlertSlackChannel[];
};
async function request<T>(method = "GET", body?: unknown, path = ""): Promise<T> {
  const response = await fetch(`/api/error-notifications${path}`, { method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiErrorMessage(result, response.status));
  return result as T;
}
export function ErrorNotificationSettingsDialog({ onClose }: { onClose: () => void }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [settings, setSettings] = useState<ErrorNotificationSettings | null>(null);
  const [services, setServices] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void request<Configuration>().then((value) => {
      if (!active) return;
      setConfiguration(value); setSettings(value.settings); setServices(value.settings.services.join(", "));
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load notifications"); });
    return () => { active = false; };
  }, []);
  function toggle(target: ErrorNotificationTarget, checked: boolean) {
    setSettings((current) => current ? { ...current, targets: checked
      ? [...current.targets.filter((item) => errorNotificationTargetKey(item) !== errorNotificationTargetKey(target)), target]
      : current.targets.filter((item) => errorNotificationTargetKey(item) !== errorNotificationTargetKey(target)) } : null);
  }
  async function save() {
    if (!settings) return;
    setSaving(true); setError(null);
    try {
      await request("PUT", { ...settings, services: services.split(",").map((service) => service.trim()).filter(Boolean) });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save notifications"); }
    finally { setSaving(false); }
  }
  async function refresh() {
    setSaving(true); setError(null);
    try {
      const { channels } = await request<{ channels: TelemetryAlertSlackChannel[] }>("POST", undefined, "/refresh-channels");
      setConfiguration((current) => current ? { ...current, channels } : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to refresh channels"); }
    finally { setSaving(false); }
  }
  const checked = (target: ErrorNotificationTarget) => settings?.targets.some((item) => errorNotificationTargetKey(item) === errorNotificationTargetKey(target)) ?? false;
  const slackTargets = settings?.targets.filter((target) => target.kind === "slack") ?? [];
  return <DashboardDialog title="Error notifications" onClose={() => { if (!saving) onClose(); }} actions={<>
    <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
    <Button disabled={!settings || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save notifications"}</Button>
  </>}>
    <p>Notify your team when a new error appears or a resolved error happens again. Repeated events on an open error stay quiet.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!configuration && !error ? <p role="status">Loading notifications…</p> : null}
    {settings && configuration ? <fieldset className="errorNotifications" disabled={saving}>
      <Checkbox label="Enable error notifications" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />
      <div className="errorNotifications__section">
        <h3>When to notify</h3>
        <Checkbox label="New errors" checked={settings.newErrors} onChange={(event) => setSettings({ ...settings, newErrors: event.target.checked })} />
        <Checkbox label="Resolved errors that happen again" checked={settings.regressions} onChange={(event) => setSettings({ ...settings, regressions: event.target.checked })} />
        <TextField label="Services" value={services} onChange={(event) => setServices(event.target.value)} placeholder="All services" />
        <p>Leave empty for all services, or enter service names separated by commas.</p>
      </div>
      <div className="errorNotifications__section">
        <h3>Slack</h3>
        {slackTargets.map((target) => <Checkbox key={errorNotificationTargetKey(target)} checked label={configuration.channels.find((channel) => channel.integrationAccountId === target.integrationAccountId && channel.channelId === target.channelId)?.name ?? `Unavailable channel (${target.channelId})`} onChange={() => toggle(target, false)} />)}
        <SelectField label="Add Slack channel" value="" options={[{ label: "Choose a channel…", value: "" }, ...configuration.channels.filter((channel) => !checked({ kind: "slack", integrationAccountId: channel.integrationAccountId, channelId: channel.channelId })).map((channel) => ({ label: `#${channel.name} (${channel.accountName})`, value: `${channel.integrationAccountId}:${channel.channelId}` }))]} onChange={(value) => {
          if (!value) return;
          const [integrationAccountId, channelId] = value.split(":");
          if (integrationAccountId && channelId) toggle({ kind: "slack", integrationAccountId, channelId }, true);
        }} />
        <Button variant="secondary" size="small" onClick={() => void refresh()}>Refresh channels</Button>
        {!configuration.channels.length ? <p>Connect Slack in <Link to="/settings">Integrations</Link>, then refresh channels.</p> : null}
      </div>
      <div className="errorNotifications__section">
        <h3>Email</h3>
        {configuration.members.map((member) => <Checkbox key={member.id} label={`${member.name} (${member.email})`} checked={checked({ kind: "email", userId: member.id })} onChange={(event) => toggle({ kind: "email", userId: member.id }, event.target.checked)} />)}
        <p>Only workspace members with verified email addresses appear here.</p>
        {settings.targets.filter((target) => target.kind === "email" && !configuration.members.some((member) => member.id === target.userId)).map((target) => <Checkbox key={errorNotificationTargetKey(target)} checked label="Unavailable email recipient — remove to save" onChange={() => toggle(target, false)} />)}
      </div>
      <p>Changes apply to future errors. Saving cancels queued notifications. A notification already being sent may still arrive.</p>
    </fieldset> : null}
  </DashboardDialog>;
}
