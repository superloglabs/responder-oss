import { useIntegrationConnect } from "./use-integration-connect";
import { PlugsConnectedIcon } from "@phosphor-icons/react";
import type { ConnectedAutomationTrigger } from "../automations-api";

export function AutomationTriggerConnect({ kind, name, onConnected, label = "Connect" }: {
  kind: ConnectedAutomationTrigger["kind"];
  name: string;
  label?: string;
  onConnected: (kind: ConnectedAutomationTrigger["kind"], signal: AbortSignal) => Promise<boolean>;
}) {
  const { connect, connecting, error } = useIntegrationConnect(kind, name, onConnected);
  return <div className="automationTrigger__connectAction">
    <button className="automationCreate__save" disabled={connecting} onClick={() => void connect()} type="button"><PlugsConnectedIcon size={16} />{connecting ? "Connecting…" : label}</button>
    {error ? <p className="automationTrigger__connectError" role="alert">{error}</p> : null}
  </div>;
}
