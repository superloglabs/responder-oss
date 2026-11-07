import { useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { authClient } from "../auth-client";
import { AppShell } from "../components/app-shell";
import { Button } from "../design-system";
import { useOrganizationCapabilities } from "../organization-capabilities";
import { homePath } from "../primary-navigation";
import { loadSignalSetupState, useSignalSetupState } from "./setup-state";
import "./signal.css";

export function SignalLayout() {
  const capabilities = useOrganizationCapabilities();
  const session = authClient.useSession();
  if (!capabilities.includes("signal")) return <Navigate replace to={homePath(capabilities)} />;
  return <SignalWorkspace key={session.data?.session.activeOrganizationId} />;
}
function SignalWorkspace() {
  const { pathname } = useLocation();
  const session = authClient.useSession();
  const setup = useSignalSetupState(session.data?.session.activeOrganizationId, true);
  // Until setup is complete, every Signal page is setup.
  const blocked = !pathname.startsWith("/signal/setup") && pathname !== "/signal";
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.closest(".workspaceSurface")?.scrollTo({ top: 0 });
  }, [pathname]);
  const active = pathname.startsWith("/signal/usage") ? "signal-usage"
    : pathname.startsWith("/signal/findings") ? "signal-findings" : "signal-setup";
  return <AppShell active={active} redesigned>
    <div className="signal" ref={contentRef}>
      {blocked && setup === "incomplete" ? <Navigate replace to="/signal/setup" />
        : blocked && setup === "loading" ? <p className="signalLoading" role="status">Loading…</p>
        : <Outlet />}
    </div>
  </AppShell>;
}

// Opens findings once setup is complete, and setup until then, from the
// state the sidebar also uses. A failed lookup stays here with a retry, since
// guessing could hide findings.
export function SignalHome() {
  const organizationId = authClient.useSession().data?.session.activeOrganizationId;
  const setup = useSignalSetupState(organizationId, true);
  if (setup === "complete") return <Navigate replace to="/signal/findings" />;
  if (setup === "incomplete") return <Navigate replace to="/signal/setup" />;
  if (setup === "unknown") {
    return <section className="signalEmpty">
      <p className="signalError" role="alert">Could not load Signal. Try again shortly.</p>
      <Button onClick={() => { if (organizationId) void loadSignalSetupState(organizationId, { retry: true }); }}>Try again</Button>
    </section>;
  }
  return <p className="signalLoading" role="status">Loading…</p>;
}
