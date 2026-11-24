import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { IconAlertCircle, IconEye, IconEyeOff } from "@tabler/icons-react";
import { Button } from "../design-system";
import { saveReplicasWebhook, type SignalSettings } from "./model";
import type { SettingsPageProps } from "./settings";
import { sourceActions } from "./setup-data";
import { ChannelSelect } from "./setup-shared";
import { SettingsGroup, SettingsPage, SettingsRow, SourceRow } from "./shared";

export function SettingsNotifications({ data, save, setSettings, status }: SettingsPageProps) {
  const navigate = useNavigate();
  const { integrations, options, settings } = data;
  const actions = sourceActions({ integrations, otelServices: null, listPath: "/signal/setup/notifications", navigate });
  const connected = actions.connected("slack");
  const workspace = actions.accounts("slack").map((account) => account.displayName).join(", ");
  return <SettingsPage title="Notifications" description="Where findings are posted." status={status}>
    <SettingsGroup title="Slack">
      <div className="signalSettingsCard">
        <SourceRow provider="slack" name="Slack"
          description={connected ? workspace || "Connected" : "Connect your workspace to post findings."}
          action={connected
            ? <Button aria-label="Manage Slack" onClick={() => actions.manage("slack")}>Manage</Button>
            : <Button disabled={!actions.summary("slack")?.connectUrl} onClick={() => actions.connect("slack")}>Connect Slack</Button>} />
        <div className="signalSettingsCard--rows">
          <SettingsRow label="Findings channel" description="Every finding is posted here.">
            <ChannelSelect options={options} value={settings.slack}
              onChange={(slack) => save({ slack })} />
          </SettingsRow>
        </div>
      </div>
    </SettingsGroup>
    <SettingsGroup title="Coding agents">
      <div className="signalSettingsCard signalSettingsCard--rows">
        <ReplicasWebhook connected={settings.replicas.connected} onSaved={(saved) => setSettings(saved, true)} />
      </div>
    </SettingsGroup>
  </SettingsPage>;
}

// The webhook URL of a Replicas automation. It is a secret, so once saved
// it can only be removed or replaced, not shown.
function ReplicasWebhook({ connected, onSaved }: { connected: boolean; onSaved: (settings: SignalSettings) => void }) {
  const [url, setUrl] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replacing, setReplacing] = useState(false);

  async function submit(webhookUrl: string | null) {
    setBusy(true);
    setError("");
    try {
      onSaved(await saveReplicasWebhook(webhookUrl));
      setUrl("");
      setReplacing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    void submit(url.trim());
  }

  if (connected && !replacing) {
    return <SettingsRow label="Send to Replicas"
      description={error
        ? <span className="signalError" role="alert">{error}</span>
        : "Findings posted to Slack from now on have a Send to Replicas button. It starts your Replicas automation with the finding's prompt."}>
      <span className="signalReplicasActions">
        <Button disabled={busy} onClick={() => setReplacing(true)}>Replace URL</Button>
        <Button disabled={busy} loading={busy} onClick={() => void submit(null)}>Remove</Button>
      </span>
    </SettingsRow>;
  }

  return <SettingsRow stacked label="Send to Replicas"
    description="Add a Send to Replicas button to findings in Slack. In Replicas, create an automation with a custom webhook trigger, then paste its URL here.">
    <form className="signalReplicasForm" onSubmit={connect}>
      <div className={`signalInput${error ? " signalInput--error" : ""}`}>
        <div className="signalSecret">
          <input aria-label="Replicas webhook URL" type={show ? "text" : "password"} autoComplete="off" spellCheck={false}
            disabled={busy} placeholder="https://api.replicas.dev/v1/automations/webhook/whtok_…" value={url}
            onChange={(e) => { setUrl(e.target.value); setError(""); }} />
          <button type="button" aria-label={show ? "Hide URL" : "Show URL"} onClick={() => setShow(!show)}>
            {show ? <IconEyeOff size={14} /> : <IconEye size={14} />}
          </button>
        </div>
        {error ? <p className="signalFieldError" role="alert"><IconAlertCircle size={14} />{error}</p>
          : <p>Stored encrypted. Anyone with the URL can start the automation.</p>}
      </div>
      <span className="signalReplicasActions">
        {replacing && <Button disabled={busy} onClick={() => { setReplacing(false); setUrl(""); setError(""); }}>Cancel</Button>}
        <Button type="submit" variant="primary" loading={busy} disabled={busy || !url.trim()}>Connect Replicas</Button>
      </span>
    </form>
  </SettingsRow>;
}
