import { useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { authClient } from "../auth-client";
import { AppShell } from "../components/app-shell";
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

// Opens findings once Signal is on, and setup until then.
export function SignalHome() {
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    fetchSignalSettings()
      .then((settings) => { if (current) setTarget(settings.enabled ? "/signal/findings" : "/signal/setup"); })
      .catch(() => { if (current) setTarget("/signal/setup"); });
    return () => { current = false; };
  }, []);
  return target ? <Navigate replace to={target} /> : <p className="signalLoading" role="status">Loading…</p>;
}
