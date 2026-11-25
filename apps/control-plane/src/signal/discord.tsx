import { useState, type FormEvent, type ReactNode } from "react";
import { IconAlertCircle, IconCheck, IconEye, IconEyeOff } from "@tabler/icons-react";
import { Button } from "../design-system";
import {
  DiscordSaveError,
  discordWebhookUrlProblem,
  saveDiscordWebhook,
  type DiscordSaveErrorCode,
  type SignalDeliveryProblem,
  type SignalSettings,
} from "./model";
import { discordInstructions, discordProblemText } from "./destination-model";
import { SettingsRow } from "./shared";

// A problem shown on the row it belongs to, in the error colour.
export function RowError({ children }: { children: ReactNode }) {
  return <span className="signalRowError" role="alert"><IconAlertCircle aria-hidden="true" size={14} />{children}</span>;
}

// The Discord webhook of a workspace: a form for its URL while none is
// saved, and its status with Replace URL and Remove once one is. Saving
// posts a test message, so a wrong URL is caught here.
export function DiscordWebhook({ label, connected, delivery, connectedDescription, onSaved }: {
  label: string;
  connected: boolean;
  delivery: SignalDeliveryProblem | null;
  connectedDescription: string;
  onSaved: (settings: SignalSettings) => void;
}) {
  const [url, setUrl] = useState("");
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<{ code: DiscordSaveErrorCode; message: string } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const problem = delivery?.problem === "discord_webhook_gone" ? delivery : null;

  async function save(webhookUrl: string | null) {
    setError(null);
    if (webhookUrl !== null) {
      const invalid = discordWebhookUrlProblem(webhookUrl);
      if (invalid) {
        setError({ code: "invalid_url", message: invalid });
        return;
      }
    }
    const setBusy = webhookUrl === null ? setRemoving : setChecking;
    setBusy(true);
    try {
      onSaved(await saveDiscordWebhook(webhookUrl));
      setUrl("");
      setReplacing(false);
    } catch (failure) {
      setError(failure instanceof DiscordSaveError
        ? { code: failure.code, message: failure.message }
        : { code: "failed", message: "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void save(url.trim());
  }

  if (connected && !replacing) {
    return <SettingsRow label={label}
      description={error ? <RowError>{error.message}</RowError>
        : problem ? <RowError>{discordProblemText(problem)}</RowError>
        : connectedDescription}>
      <span className="signalRowActions">
        {!problem && <span className="signalConnected"><IconCheck aria-hidden="true" size={14} />Connected</span>}
        <Button variant={problem ? "primary" : undefined} disabled={removing} onClick={() => { setError(null); setReplacing(true); }}>Replace URL</Button>
        <Button disabled={removing} loading={removing} onClick={() => void save(null)}>Remove</Button>
      </span>
    </SettingsRow>;
  }

  // The URL may be fine when Discord did not answer, so the field is not
  // marked wrong then.
  const invalid = error !== null && error.code !== "unavailable";
  return <SettingsRow stacked label="Webhook URL" description={discordInstructions}>
    <form className="signalWebhookForm" onSubmit={submit}>
      <div className="signalWebhookForm__field">
        <div className={`signalSecret${invalid ? " signalSecret--error" : ""}`}>
          <input aria-label="Discord webhook URL" aria-invalid={invalid} type={show ? "text" : "password"} autoComplete="off" spellCheck={false}
            disabled={checking} placeholder="https://discord.com/api/webhooks/…" value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null); }} />
          <button type="button" aria-label={show ? "Hide URL" : "Show URL"} onClick={() => setShow(!show)}>
            {show ? <IconEyeOff size={14} /> : <IconEye size={14} />}
          </button>
        </div>
        {replacing && <Button disabled={checking} onClick={() => { setReplacing(false); setUrl(""); setError(null); }}>Cancel</Button>}
        <Button type="submit" variant="primary" disabled={checking || !url.trim()}>
          {checking ? "Checking…" : error?.code === "unavailable" ? "Try again" : "Connect Discord"}
        </Button>
      </div>
      {error ? <RowError>{error.message}</RowError>
        : <p className="signalWebhookForm__note">{checking
          ? "Posting a test message to the channel…"
          : "Signal posts a short test message to check the URL. Stored encrypted."}</p>}
    </form>
  </SettingsRow>;
}
