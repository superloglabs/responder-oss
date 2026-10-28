import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ErrorNotificationSettings } from "../../../../packages/core/src/telemetry/error-notifications";
import type { TelemetryAlertSlackChannel } from "../../../../packages/core/src/db/telemetry-alerts";
import { Button, Switch, SelectField } from "../design-system";
import { DashboardDialog } from "./dashboard-dialog";
import "./dashboards.css";
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
  return <DashboardDialog title="Error notifications" onClose={() => { if (!saving) onClose(); }} actions={<>
    <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
    <Button disabled={!settings || saving || (settings.enabled && !target)} onClick={() => void save()}>{saving ? "Saving…" : "Save notifications"}</Button>
  </>}>
    <p>Notify your team when a new error appears or a resolved error happens again.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!configuration && !error ? <p role="status">Loading notifications…</p> : null}
    {settings && configuration ? <fieldset className="errorNotifications" disabled={saving}>
      <Switch label="Enable error notifications" checked={settings.enabled} onCheckedChange={(enabled) => setSettings({ ...settings, enabled })} />
      <SelectField label="Slack channel" value={target ? `${target.integrationAccountId}:${target.channelId}` : ""} options={[{ label: "Choose a channel…", value: "" }, ...configuration.channels.map((channel) => ({ label: `#${channel.name} (${channel.accountName})`, value: `${channel.integrationAccountId}:${channel.channelId}` }))]} onChange={(value) => {
        const [integrationAccountId, channelId] = value.split(":");
        setSettings({ ...settings, targets: integrationAccountId && channelId ? [{ kind: "slack", integrationAccountId, channelId }] : [] });
      }} />
      {!configuration.channels.length ? <p>Connect Slack in <Link to="/settings">Integrations</Link> to choose a channel.</p> : null}
    </fieldset> : null}
  </DashboardDialog>;
}
