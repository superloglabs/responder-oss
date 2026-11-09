import { useEffect, useRef, useState } from "react";
import { Navigate, NavLink, useLocation, useParams, useSearchParams } from "react-router-dom";
import { IconAdjustmentsHorizontal, IconBell, IconChecklist, IconDatabase, IconReceiptDollar } from "@tabler/icons-react";
import { saveSignalSettings, type SignalSettings } from "./model";
import { SignalPlanSettings } from "./plan";
import { sourceName } from "./setup-data";
import type { SetupViewProps } from "./setup";
import { SettingsGeneral } from "./settings-general";
import { SettingsNotifications } from "./settings-notifications";
import { SettingsSources } from "./settings-sources";
import type { SaveStatus } from "./shared";

const sections = [
  { id: "general", label: "General", Icon: IconAdjustmentsHorizontal },
  { id: "sources", label: "Sources", Icon: IconDatabase },
  { id: "notifications", label: "Notifications", Icon: IconBell },
  { id: "plan", label: "Plan", Icon: IconReceiptDollar },
] as const;

// Setup steps, for links made before setup was complete, such as where a
// provider's sign-in comes back to.
const stepSections: Record<string, string> = {
  telemetry: "sources", context: "sources", code: "sources", repositories: "sources", slack: "notifications",
};

export type SaveSettings = (patch: Partial<SignalSettings>) => void;

export interface SettingsPageProps extends SetupViewProps {
  save: SaveSettings;
  // Shows a failure that is not a save, such as loading the plan.
  fail: (message: string) => void;
  status: SaveStatus;
}

// Saves each change as it is made, in order. A change shows at once and is
// undone if its save fails. The outcome keeps the page it was made on.
function useSettingsSaver(settings: SignalSettings, setSettings: SetupViewProps["setSettings"]) {
  const [status, setStatus] = useState<{ path: string; status: SaveStatus } | null>(null);
  const latest = useRef(settings);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const failed = useRef(false);
  useEffect(() => { latest.current = settings; }, [settings]);

  function save(patch: Partial<SignalSettings>, path: string) {
    const before = latest.current;
    latest.current = { ...before, ...patch };
    setSettings(latest.current);
    if (pending.current === 0) failed.current = false;
    pending.current += 1;
    setStatus({ path, status: { state: "saving" } });
    queue.current = queue.current.then(async () => {
      try {
        const saved = await saveSignalSettings(latest.current);
        pending.current -= 1;
        if (pending.current > 0) return;
        latest.current = saved;
        setSettings(saved, true);
        if (!failed.current) setStatus({ path, status: { state: "saved" } });
      } catch (failure) {
        pending.current -= 1;
        failed.current = true;
        const restored = Object.fromEntries(Object.keys(patch).map((key) => [key, before[key as keyof SignalSettings]]));
        latest.current = { ...latest.current, ...restored };
        setSettings(latest.current);
        setStatus({ path, status: { state: "error", message: failure instanceof Error ? failure.message : "Could not save." } });
      }
    });
  }
  return {
    save,
    status: (path: string) => status?.path === path ? status.status : null,
    fail: (message: string, path: string) => setStatus({ path, status: { state: "error", message } }),
  };
}

export function SignalSettingsView(props: SetupViewProps) {
  const { step: section, page: provider, mode } = useParams();
  const { search, pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { settings } = props.data;
  const saver = useSettingsSaver(settings, props.setSettings);

  const mapped = section ? stepSections[section] : undefined;
  if (mapped) {
    const page = provider && ["telemetry", "context"].includes(section!) ? `/${provider}${mode ? `/${mode}` : ""}` : "";
    return <Navigate replace to={`/signal/setup/${mapped}${page}${search}`} />;
  }
  if (!sections.some((candidate) => candidate.id === section)) return <Navigate replace to="/signal/setup/general" />;
  if (section !== "sources" && provider) return <Navigate replace to={`/signal/setup/${section}`} />;

  const pageProps: SettingsPageProps = {
    ...props,
    save: (patch) => saver.save(patch, pathname),
    fail: (message) => saver.fail(message, pathname),
    status: saver.status(pathname),
  };
  // A provider's own site sends people back here with the outcome.
  const failedProvider = searchParams.get("status") === "error" ? searchParams.get("integration") : null;

  return <section className="signalSettings">
    <header className="signalSettingsHeader">
      <h1 className="signalListHeading"><IconChecklist size={16} stroke={2} />Setup</h1>
      <span className={`signalStatusPill${settings.enabled ? " signalStatusPill--on" : ""}`}><i aria-hidden="true" />Signal is {settings.enabled ? "on" : "off"}</span>
    </header>
    <div className="signalSettingsColumns">
      <nav className="signalSettingsNav" aria-label="Setup sections">
        {sections.map(({ id, label, Icon }) => <NavLink key={id} to={`/signal/setup/${id}`}><Icon aria-hidden="true" size={16} stroke={2} />{label}</NavLink>)}
      </nav>
      <div className="signalSettingsContent">
        {failedProvider && <p className="signalError" role="alert">
          Could not connect {sourceName(failedProvider)}. Try again{searchParams.get("reason") ? ` (${searchParams.get("reason")})` : ""}.{" "}
          <button type="button" className="signalLinkButton" onClick={() => setSearchParams({}, { replace: true })}>Dismiss</button>
        </p>}
        {section === "general" ? <SettingsGeneral {...pageProps} />
          : section === "sources" ? <SettingsSources {...pageProps} provider={provider} mode={mode} />
          : section === "notifications" ? <SettingsNotifications {...pageProps} />
          : <SignalPlanSettings settings={settings} />}
      </div>
    </div>
  </section>;
}
