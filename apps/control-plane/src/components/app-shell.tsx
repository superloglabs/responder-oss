import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { authErrorCode } from "../auth-error-code";
import { authClient } from "../auth-client";
import { resetBrowserAnalytics } from "../browser-analytics";
import { BillingBanner } from "./billing-banner";
import {
  CaretDownIcon,
  CheckIcon,
  FlagIcon,
  GearIcon,
  LightningIcon,
  ListIcon,
  ListBulletsIcon,
  ScanIcon,
  RobotIcon,
  SignOutIcon,
  UserCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ColorThemeToggle } from "./color-theme-toggle";
import "./workspace.css";

interface AppShellProps {
  active: "agents" | "automations" | "issues" | "scans" | "settings" | "suggestions";
  children: ReactNode;
  // Shown to a signed-out visitor of a public page in place of the account
  // menu. The navigation stays as members see it.
  guest?: ReactNode;
  redesigned?: boolean;
  density?:
    | "default"
    | "compact"
    | "create"
    | "edit"
    | "investigation"
    | "scans"
    | "settings"
    | "issues";
}

export function AppShell({ active, children, density = "default", guest, redesigned = false }: AppShellProps) {
  const workspace = redesigned || density === "issues";
  const session = authClient.useSession();
  const activeOrganization = authClient.useActiveOrganization();
  const organizations = authClient.useListOrganizations();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [automationsEnabled, setAutomationsEnabled] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSidebarFocusRef = useRef(false);
  const displayName = session.data?.user.name || session.data?.user.email || "Account";
  const initials = displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    if (guest) return;
    let cancelled = false;
    void fetch("/api/context")
      .then(async (response) => response.ok
        ? response.json() as Promise<{ capabilities?: string[] }>
        : null)
      .then((context) => {
        if (!cancelled) {
          setAutomationsEnabled(context?.capabilities?.includes("automations") ?? false);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [guest, session.data?.session.activeOrganizationId]);

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

  useEffect(() => {
    if (!isSidebarOpen && restoreSidebarFocusRef.current) {
      restoreSidebarFocusRef.current = false;
      sidebarTriggerRef.current?.focus();
    }
  }, [isSidebarOpen]);

  useEffect(() => {
    if (!isSidebarOpen || !workspace) return;

    const media = window.matchMedia("(max-width: 600px)");
    if (!media.matches) return;

    sidebarRef.current?.querySelector<HTMLAnchorElement>(".primaryNav a")?.focus();

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        restoreSidebarFocusRef.current = true;
        setIsSidebarOpen(false);
      } else if (event.key === "Tab") {
        const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled])',
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    function closeOnResize() {
      if (!media.matches) setIsSidebarOpen(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    media.addEventListener("change", closeOnResize);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      media.removeEventListener("change", closeOnResize);
    };
  }, [isSidebarOpen, workspace]);

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
    <main className={`appShell appShell--${density}${workspace ? " appShell--workspace" : ""}${workspace && isSidebarOpen ? " appShell--sidebarOpen" : ""}`}>
      {workspace && isSidebarOpen ? (
        <button
          aria-hidden="true"
          className="mobileSidebarBackdrop"
          onClick={() => {
            restoreSidebarFocusRef.current = true;
            setIsSidebarOpen(false);
          }}
          tabIndex={-1}
          type="button"
        />
      ) : null}
      <header
        aria-label={workspace && isSidebarOpen ? "Navigation" : undefined}
        aria-modal={workspace && isSidebarOpen ? true : undefined}
        className={`globalHeader${workspace && isSidebarOpen ? " globalHeader--open" : ""}`}
        id={workspace ? "workspace-sidebar" : undefined}
        ref={sidebarRef}
        role={workspace && isSidebarOpen ? "dialog" : undefined}
      >
        {workspace ? (
          <button
            aria-label="Close navigation"
            className="mobileSidebarClose"
            onClick={() => {
              restoreSidebarFocusRef.current = true;
              setIsSidebarOpen(false);
            }}
            type="button"
          >
            <XIcon aria-hidden="true" size={20} />
          </button>
        ) : null}
        <div className="globalHeader__left">
          <Link aria-label="Superlog home" className="brand" onClick={() => setIsSidebarOpen(false)} to="/agents">
            {workspace ? (
              <svg aria-hidden="true" className="brandPictogram" width="16" height="16" viewBox="175 175 350 350" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <rect x="347.464" y="347.464" width="96.3768" height="96.3768" />
                <rect x="175" y="256.159" width="81.1594" height="187.681" />
                <rect x="443.841" y="256.159" width="81.1594" height="187.681" />
                <rect x="443.841" y="175" width="81.1594" height="187.681" transform="rotate(90 443.841 175)" />
                <rect x="443.841" y="443.841" width="81.1594" height="187.681" transform="rotate(90 443.841 443.841)" />
              </svg>
            ) : (
              <img alt="Superlog" draggable={false} src="/superlog-wordmark.svg" />
            )}
          </Link>
          <nav aria-label="Primary navigation" className="primaryNav" onClick={() => setIsSidebarOpen(false)}>
            <Link
              aria-current={active === "agents" ? "page" : undefined}
              className={active === "agents" ? "isActive" : undefined}
              to="/agents"
            >
              {workspace ? <LightningIcon size={16} aria-hidden="true" /> : null}
              Agents
            </Link>
            {automationsEnabled || guest ? (
              <Link
                aria-current={active === "automations" ? "page" : undefined}
                className={active === "automations" ? "isActive" : undefined}
                to="/automations"
              >
                {workspace ? <RobotIcon size={16} aria-hidden="true" /> : null}
                Automations
              </Link>
            ) : null}
            <Link
              aria-current={active === "issues" ? "page" : undefined}
              className={active === "issues" ? "isActive" : undefined}
              to="/issues"
            >
              {workspace ? <ListBulletsIcon size={16} aria-hidden="true" /> : null}
              Issues
            </Link>
            <Link
              aria-current={active === "scans" ? "page" : undefined}
              className={active === "scans" ? "isActive" : undefined}
              to="/scans"
            >
              {workspace ? <ScanIcon size={16} aria-hidden="true" /> : null}
              Scans
            </Link>
            <Link
              aria-current={active === "suggestions" ? "page" : undefined}
              className={active === "suggestions" ? "isActive" : undefined}
              to="/suggestions"
            >
              {workspace ? <FlagIcon size={16} aria-hidden="true" /> : null}
              Suggestions
            </Link>
            <Link
              aria-current={active === "settings" ? "page" : undefined}
              className={active === "settings" ? "isActive" : undefined}
              to="/settings"
            >
              {workspace ? <GearIcon size={16} aria-hidden="true" /> : null}
              Settings
            </Link>
          </nav>
        </div>
        <div className="globalHeader__right" ref={menuRef}>
          {!workspace ? <ColorThemeToggle className="globalThemeToggle" /> : null}
          {guest ?? <div className="accountMenu">
            <button
              aria-expanded={isMenuOpen}
              aria-haspopup="menu"
              aria-label={`Open ${activeOrganization.data?.name ?? "workspace"} and account menu for ${displayName}`}
              className="accountMenuTrigger"
              onClick={() => setIsMenuOpen((value) => !value)}
              type="button"
            >
              <span className="accountMenuTrigger__workspace">
                {workspace ? displayName : activeOrganization.data?.name ?? "Workspace"}
              </span>
              <span className="avatar accountMenuTrigger__avatar">
                {session.data?.user.image ? (
                  <img alt="" src={session.data.user.image} />
                ) : (
                  initials
                )}
              </span>
              {!workspace ? <CaretDownIcon aria-hidden="true" size={12} /> : null}
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
                            <CheckIcon aria-hidden="true" size={12} />
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
                      {workspace ? <UserCircleIcon aria-hidden="true" size={16} /> : null}
                      User support
                    </Link>
                  ) : null}
                  <Link
                    className="accountPopover__item"
                    onClick={() => setIsMenuOpen(false)}
                    role="menuitem"
                    to="/settings/workspace"
                  >
                    {workspace ? <GearIcon aria-hidden="true" size={16} /> : null}
                    Workspace settings
                  </Link>
                </div>
                <div className="accountPopover__section">
                  <button
                    className="accountPopover__item accountPopover__item--danger"
                    onClick={() => void signOut()}
                    role="menuitem"
                    type="button"
                  >
                    {workspace ? <SignOutIcon aria-hidden="true" size={16} /> : null}
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
          </div>}
        </div>
      </header>
      {workspace ? (
        <div className="workspaceSurface" inert={isSidebarOpen}>
          <div className="mobileSidebarBar">
            <button
              aria-controls="workspace-sidebar"
              aria-expanded={isSidebarOpen}
              aria-label="Open navigation"
              className="mobileSidebarTrigger"
              onClick={() => setIsSidebarOpen(true)}
              ref={sidebarTriggerRef}
              type="button"
            >
              <ListIcon aria-hidden="true" size={20} />
            </button>
          </div>
          {guest ? null : <BillingBanner />}<div className="workspaceContent">{children}</div>
        </div>
      ) : <>{guest ? null : <BillingBanner />}{children}</>}
    </main>
  );
}
