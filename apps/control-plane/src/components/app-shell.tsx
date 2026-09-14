import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { authErrorCode } from "../auth-error-code";
import { authClient } from "../auth-client";
import { resetBrowserAnalytics } from "../browser-analytics";
import { BillingBanner } from "./billing-banner";
import { ColorThemeToggle } from "./color-theme-toggle";

interface AppShellProps {
  active: "agents" | "issues" | "knowledge" | "settings";
  children: ReactNode;
  density?:
    | "default"
    | "compact"
    | "create"
    | "edit"
    | "investigation"
    | "settings";
}

export function AppShell({ active, children, density = "default" }: AppShellProps) {
  const session = authClient.useSession();
  const activeOrganization = authClient.useActiveOrganization();
  const organizations = authClient.useListOrganizations();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayName = session.data?.user.name || session.data?.user.email || "Account";
  const initials = displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    if (!isMenuOpen) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        setIsMenuOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsMenuOpen(false);
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isMenuOpen]);

  async function switchWorkspace(organizationId: string) {
    if (organizationId === session.data?.session.activeOrganizationId) {
      setIsMenuOpen(false);
      return;
    }
    setSwitchingTo(organizationId);
    const result = await authClient.organization.setActive({ organizationId });
    setSwitchingTo(null);
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "workspace_switch_failed",
          organizationId,
          errorCode: authErrorCode(result.error),
        }),
      );
      return;
    }
    console.info(
      JSON.stringify({
        event: "workspace_switch_success",
        organizationId,
      }),
    );
    window.location.assign("/agents");
  }

  async function signOut() {
    setMenuError(null);
    const result = await authClient.signOut();
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "sign_out_failed",
          source: "account_menu",
          errorCode: authErrorCode(result.error),
        }),
      );
      setMenuError("Could not log out. Please try again.");
      return;
    }
    console.info(
      JSON.stringify({
        event: "sign_out_success",
        source: "account_menu",
      }),
    );
    await resetBrowserAnalytics();
    window.location.assign("/");
  }

  return (
    <main className={`appShell appShell--${density}`}>
      <header className="globalHeader">
        <div className="globalHeader__left">
          <Link aria-label="Superlog home" className="brand" to="/agents">
            <img alt="Superlog" draggable={false} src="/superlog-wordmark.svg" />
          </Link>
          <nav aria-label="Primary navigation" className="primaryNav">
            <Link
              aria-current={active === "agents" ? "page" : undefined}
              className={active === "agents" ? "isActive" : undefined}
              to="/agents"
            >
              Agents
            </Link>
            <Link
              aria-current={active === "knowledge" ? "page" : undefined}
              className={active === "knowledge" ? "isActive" : undefined}
              to="/knowledge"
            >
              Knowledge
            </Link>
            <Link
              aria-current={active === "issues" ? "page" : undefined}
              className={active === "issues" ? "isActive" : undefined}
              to="/issues"
            >
              Issues
            </Link>
            <Link
              aria-current={active === "settings" ? "page" : undefined}
              className={active === "settings" ? "isActive" : undefined}
              to="/settings"
            >
              Settings
            </Link>
          </nav>
        </div>
        <div className="globalHeader__right" ref={menuRef}>
          <ColorThemeToggle className="globalThemeToggle" />
          <div className="accountMenu">
            <button
              aria-expanded={isMenuOpen}
              aria-haspopup="menu"
              aria-label={`Open ${activeOrganization.data?.name ?? "workspace"} and account menu for ${displayName}`}
              className="accountMenuTrigger"
              onClick={() => setIsMenuOpen((value) => !value)}
              type="button"
            >
              <span className="accountMenuTrigger__workspace">
                {activeOrganization.data?.name ?? "Workspace"}
              </span>
              <span className="avatar accountMenuTrigger__avatar">
                {session.data?.user.image ? (
                  <img alt="" src={session.data.user.image} />
                ) : (
                  initials
                )}
              </span>
              <svg
                aria-hidden="true"
                fill="none"
                height="12"
                viewBox="0 0 12 12"
                width="12"
              >
                <path
                  d="m3.25 4.75 2.75 2.5 2.75-2.5"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {isMenuOpen ? (
              <div className="accountPopover" role="menu">
                <div className="accountPopover__user">
                  <strong>{displayName}</strong>
                  <span>{session.data?.user.email}</span>
                </div>
                <div className="accountPopover__section">
                  <span className="accountPopover__label">Workspaces</span>
                  {organizations.data?.map((organization) => {
                    const isActive =
                      organization.id ===
                      session.data?.session.activeOrganizationId;
                    return (
                      <button
                        className="accountPopover__item"
                        disabled={switchingTo !== null}
                        key={organization.id}
                        onClick={() => void switchWorkspace(organization.id)}
                        role="menuitem"
                        type="button"
                      >
                        <span className="workspaceMonogram">
                          {organization.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span>{organization.name}</span>
                        {isActive ? (
                          <span aria-label="Active workspace" className="menuCheck">
                            ✓
                          </span>
                        ) : switchingTo === organization.id ? (
                          <span className="menuCheck">…</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <div className="accountPopover__section">
                  {session.data?.user.role?.split(",").includes("superuser") ? (
                    <Link
                      className="accountPopover__item"
                      onClick={() => setIsMenuOpen(false)}
                      role="menuitem"
                      to="/superuser/users"
                    >
                      User support
                    </Link>
                  ) : null}
                  <Link
                    className="accountPopover__item"
                    onClick={() => setIsMenuOpen(false)}
                    role="menuitem"
                    to="/settings/workspace"
                  >
                    Workspace settings
                  </Link>
                  <button
                    className="accountPopover__item accountPopover__item--danger"
                    onClick={() => void signOut()}
                    role="menuitem"
                    type="button"
                  >
                    Log out
                  </button>
                  {menuError ? (
                    <p className="accountPopover__error" role="alert">
                      {menuError}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <BillingBanner />
      {children}
    </main>
  );
}
