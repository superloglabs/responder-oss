import { useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { authClient } from "../auth-client";
import { AppShell } from "../components/app-shell";
import { Button } from "../design-system";
import { useOrganizationCapabilities } from "../organization-capabilities";
import { homePath } from "../primary-navigation";
import { fetchSignalSettings } from "./model";
import "./signal.css";

export function SignalLayout() {
  const capabilities = useOrganizationCapabilities();
  const session = authClient.useSession();
  if (!capabilities.includes("signal")) return <Navigate replace to={homePath(capabilities)} />;
  return <SignalWorkspace key={session.data?.session.activeOrganizationId} />;
}
function SignalWorkspace() {
  const { pathname } = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.closest(".workspaceSurface")?.scrollTo({ top: 0 });
  }, [pathname]);
  const active = pathname.startsWith("/signal/usage") ? "signal-usage"
    : pathname.startsWith("/signal/findings") ? "signal-findings" : "signal-setup";
  return <AppShell active={active} redesigned>
    <div className="signal" ref={contentRef}><Outlet /></div>
  </AppShell>;
}

// Opens findings once Signal is on, and setup until then. A failed lookup
// stays here with its error, since guessing could hide findings.
export function SignalHome() {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; target?: string; error?: string } | null>(null);
  useEffect(() => {
    let current = true;
    fetchSignalSettings()
      .then((settings) => { if (current) setResult({ attempt, target: settings.enabled ? "/signal/findings" : "/signal/setup" }); })
      .catch((failure: unknown) => {
        if (current) setResult({ attempt, error: failure instanceof Error ? failure.message : "Could not load Signal." });
      });
    return () => { current = false; };
  }, [attempt]);
  if (result?.attempt === attempt && result.target) return <Navigate replace to={result.target} />;
  if (result?.attempt === attempt && result.error) {
    return <section className="signalEmpty">
      <p className="signalError" role="alert">{result.error}</p>
      <Button onClick={() => setAttempt(attempt + 1)}>Try again</Button>
    </section>;
  }
  return <p className="signalLoading" role="status">Loading…</p>;
}
