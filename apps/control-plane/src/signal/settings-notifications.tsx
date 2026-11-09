import { useNavigate } from "react-router-dom";
import { Button } from "../design-system";
import type { SettingsPageProps } from "./settings";
import { sourceActions } from "./setup-data";
import { ChannelSelect } from "./setup-shared";
import { SettingsGroup, SettingsPage, SettingsRow, SourceRow } from "./shared";

export function SettingsNotifications({ data, save, status }: SettingsPageProps) {
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
          action={<Button disabled={!actions.summary("slack")?.connectUrl} onClick={() => actions.connect("slack")}>
            {connected ? "Change workspace" : "Connect Slack"}
          </Button>} />
        <div className="signalSettingsCard--rows">
          <SettingsRow label="Findings channel" description="Every finding is posted here.">
            <ChannelSelect options={options} value={settings.slack}
              onChange={(slack) => { if (slack) save({ slack }); }} />
          </SettingsRow>
        </div>
      </div>
    </SettingsGroup>
  </SettingsPage>;
}
