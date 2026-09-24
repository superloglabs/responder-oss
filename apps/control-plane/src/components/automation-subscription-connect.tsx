import { useEffect, useRef, useState } from "react";
import { cancelAutomationSubscription, pollAutomationSubscription, startAutomationSubscription, type SubscriptionConnection } from "../automations-api";

export function AutomationSubscriptionConnect({ onConnected }: { onConnected: (credentialId: string) => Promise<void> }) {
  const [connection, setConnection] = useState<SubscriptionConnection | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const connectedCallback = useRef(onConnected);
  useEffect(() => { connectedCallback.current = onConnected; }, [onConnected]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!connection) return;
    let active = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (Date.now() >= new Date(connection!.expiresAt).getTime()) throw new Error("Sign-in expired. Please try again.");
        const result = await pollAutomationSubscription(connection!.connectionId).catch((cause: unknown) => {
          failures++;
          if (failures >= 3) throw cause;
          return null;
        });
        if (!active) return;
        if (!result) { timer = setTimeout(() => void poll(), connection!.interval * 1000); return; }
        failures = 0;
        if (result.status === "failed") throw new Error(result.error ?? "ChatGPT authorization failed. Please try again.");
        if (!active) return;
        if (result.status === "expired") throw new Error("Sign-in expired. Please try again.");
        if (result.status === "connected" && result.credentialId) { await connectedCallback.current(result.credentialId); return; }
        timer = setTimeout(() => void poll(), connection!.interval * 1000);
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : "Could not complete sign-in."); setConnection(null); }
      }
    }
    timer = setTimeout(() => void poll(), connection.interval * 1000);
    return () => { active = false; clearTimeout(timer); void cancelAutomationSubscription(connection.connectionId).catch(() => {}); };
  }, [connection]);
  async function start() {
    setStarting(true); setError(null);
    try {
      const result = await startAutomationSubscription();
      if (!mounted.current) { void cancelAutomationSubscription(result.connectionId).catch(() => {}); return; }
      setConnection(result);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to start sign-in."); }
    finally { if (mounted.current) setStarting(false); }
  }
  return <div className="automationModel__footer">
    {connection ? <>
      <div>Enter this code on the ChatGPT sign-in page:</div>
      <code className="automationModel__deviceCode">{connection.userCode}</code>
      <a className="automationModel__save" href={connection.verificationUrl} target="_blank" rel="noopener noreferrer">Continue to ChatGPT ↗</a>
      <div role="status">Waiting for sign-in…</div>
      <div>Enable device-code login in ChatGPT security settings if prompted.</div>
      <button type="button" onClick={() => setConnection(null)}>Cancel</button>
    </> : <>
      <div>Use your ChatGPT subscription with the Codex harness.</div><div>This connection is available to automations in this workspace.</div>
      <button className="automationModel__save" type="button" disabled={starting} onClick={() => void start()}>{starting ? "Connecting…" : "Connect subscription ↗"}</button>
    </>}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
