import { useEffect, useRef, useState } from "react";
import { PlugsConnectedIcon } from "@phosphor-icons/react";
import type { AutomationTrigger } from "../automations-api";

export function AutomationTriggerConnect({ kind, name, onConnected }: {
  kind: AutomationTrigger["kind"];
  name: string;
  onConnected: (kind: AutomationTrigger["kind"]) => Promise<boolean>;
}) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<() => void>(() => undefined);
  useEffect(() => () => cleanupRef.current(), []);

  async function connect() {
    cleanupRef.current();
    setError(null);
    const requestId = crypto.randomUUID();
    const returnTo = `/automations/connection-complete?request=${requestId}`;
    const popup = window.open(`${returnTo}&status=connecting`, `automation-connect-${requestId}`, "popup,width=640,height=760");
    if (!popup) {
      setError("Allow pop-ups for this site, then try connecting again.");
      return;
    }
    setConnecting(true);
    let finished = false;
    function cleanup() {
      finished = true;
      clearInterval(timer);
      window.removeEventListener("message", receive);
      if (!popup!.closed) popup!.close();
    }
    cleanupRef.current = cleanup;
    async function complete(status?: string) {
      if (finished) return;
      cleanup();
      try {
        if (status === "error") {
          setError(`Unable to connect ${name}. Please try again.`);
        } else if (!(await onConnected(kind))) {
          setError(status === "connected" ? `${name} connected, but its resources are not available yet. Try again to refresh the connection.` : "Connection cancelled. You can try again when ready.");
        }
      } catch {
        setError("Could not refresh the connection. Please try again.");
      } finally {
        setConnecting(false);
      }
    }
    function receive(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      const data = event.data;
      if (data?.type !== "automation-connection-complete" || data.requestId !== requestId || data.provider !== kind || !["connected", "error"].includes(data.status)) return;
      void complete(data.status);
    }
    window.addEventListener("message", receive);
    const timer = setInterval(() => { if (popup.closed) void complete(); }, 500);
    try {
      const response = await fetch("/api/integrations");
      if (!response.ok) throw new Error("Unable to load connections. Please try again.");
      const { integrations } = await response.json() as { integrations: Array<{ id: string; connectUrl: string | null }> };
      const integration = integrations.find((item) => item.id === kind);
      if (!integration?.connectUrl) throw new Error(`${name} connections are not configured for this installation.`);
      const url = new URL(integration.connectUrl, window.location.origin);
      if (url.origin !== window.location.origin) throw new Error("Invalid connection URL.");
      url.searchParams.set("returnTo", returnTo);
      if (!finished) popup.location.href = url.toString();
    } catch (cause) {
      if (finished) return;
      cleanup();
      setConnecting(false);
      setError(cause instanceof Error ? cause.message : "Unable to start the connection.");
    }
  }

  return <div className="automationTrigger__connectAction">
    <button className="automationCreate__save" disabled={connecting} onClick={() => void connect()} type="button"><PlugsConnectedIcon size={16} />{connecting ? "Connecting…" : "Connect"}</button>
    {error ? <p className="automationTrigger__connectError" role="alert">{error}</p> : null}
  </div>;
}
