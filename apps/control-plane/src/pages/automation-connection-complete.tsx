import { useEffect } from "react";

/** OAuth returns here in the popup; the editor and its unsaved draft stay open. */
export function AutomationConnectionCompletePage() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const requestId = params.get("request");
  const provider = params.get("integration");
  useEffect(() => {
    if (!window.opener || !requestId || !["connected", "finishing", "error"].includes(status ?? "")) return;
    window.opener.postMessage({ type: "automation-connection-complete", requestId, provider, status }, window.location.origin);
    // The editor closes the window after receiving the result.
  }, [provider, requestId, status]);
  return <main className="automationConnectionComplete">
    <h1>{status === "connecting" ? "Connecting…" : status === "finishing" ? "Finishing connection…" : status === "connected" ? "Connection complete" : "Connection not completed"}</h1>
    <p>{status === "connecting" ? "Opening the provider’s authorization page." : "You can return to your automation. Your draft is still open in the original tab."}</p>
    {status !== "connecting" ? <button onClick={() => window.close()} type="button">Close window</button> : null}
  </main>;
}
