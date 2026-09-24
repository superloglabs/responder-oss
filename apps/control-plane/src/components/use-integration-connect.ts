import { useEffect, useRef, useState } from "react";

// Connects an integration in a popup and keeps the automation draft open.
// onConnected reloads options and reports whether the connection is usable.
export function useIntegrationConnect<Kind extends string>(kind: Kind, name: string, onConnected: (kind: Kind, signal: AbortSignal) => Promise<boolean>) {
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
    const controller = new AbortController();
    function cleanupPopup() {
      finished = true;
      clearInterval(timer);
      window.removeEventListener("message", receive);
      if (!popup!.closed) popup!.close();
    }
    function cleanup() { controller.abort(); cleanupPopup(); }
    cleanupRef.current = cleanup;
    async function complete(status?: string) {
      if (finished) return;
      cleanupPopup();
      try {
        if (status === "error") {
          setError(`Unable to connect ${name}. Please try again.`);
        } else {
          let connected = await onConnected(kind, controller.signal);
          if (controller.signal.aborted) return;
          for (let attempt = 0; !connected && status === "finishing" && attempt < 10; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (controller.signal.aborted) return;
            connected = await onConnected(kind, controller.signal);
            if (controller.signal.aborted) return;
          }
          if (controller.signal.aborted) return;
          if (!connected) {
            setError(status === "connected" || status === "finishing" ? `${name} connected, but its resources are not available yet. Try again to refresh the connection.` : "Connection cancelled. You can try again when ready.");
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        setError("Could not refresh the connection. Please try again.");
      } finally {
        if (!controller.signal.aborted) setConnecting(false);
      }
    }
    function receive(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      const data = event.data;
      if (data?.type !== "automation-connection-complete" || data.requestId !== requestId || data.provider !== kind || !["connected", "finishing", "error"].includes(data.status)) return;
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

  return { connect, connecting, error };
}
