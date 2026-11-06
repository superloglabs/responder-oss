import { useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { authClient } from "../auth-client";
import { AppShell } from "../components/app-shell";
import { useOrganizationCapabilities } from "../organization-capabilities";
import { homePath } from "../primary-navigation";
import { initialPreview, SignalContext } from "./model";
import "./signal.css";

export function SignalLayout() {
  const capabilities = useOrganizationCapabilities();
  const session = authClient.useSession();
  if (!capabilities.includes("signal")) return <Navigate replace to={homePath(capabilities)} />;
  return <SignalWorkspace key={session.data?.session.activeOrganizationId} />;
}
function SignalWorkspace() {
  const [preview, setPreview] = useState(initialPreview);
  const { pathname } = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.closest(".workspaceSurface")?.scrollTo({ top: 0 });
  }, [pathname]);
  const active = pathname.startsWith("/signal/usage") ? "signal-usage"
    : pathname.startsWith("/signal/findings") ? "signal-findings" : "signal-setup";
  return <SignalContext.Provider value={{ preview, setPreview }}>
    <AppShell active={active} redesigned>
      <div className="signal" ref={contentRef}><Outlet /></div>
      <p className="signalPreviewNote">Preview · Sample data. Connections and plans are simulated.</p>
    </AppShell>
  </SignalContext.Provider>;
}

