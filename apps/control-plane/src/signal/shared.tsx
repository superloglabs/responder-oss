import type { ReactNode } from "react";
import { IconCheck } from "@tabler/icons-react";
import { ProviderGlyph } from "../components/icons";
import type { ProviderGlyphId } from "../components/provider-glyphs";
import { Button } from "../design-system";
import { signalPeriods, type SignalPeriod, type SignalSeverity } from "./model";

export function SignalLogo({ provider }: { provider: string }) {
  if (provider === "aws") return <span className="signalLogo signalAws" aria-hidden="true"><span>aws</span><svg width="28" height="8" viewBox="0 0 28 8"><path d="M2 1 Q14 9 25 1 M21 1 L26 0 L25 5" fill="none" stroke="#ff9900" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></span>;
  if (provider === "otel" || provider === "jira") return <img className="signalLogo" src={`/signal/${provider}.svg`} alt="" />;
  return <ProviderGlyph decorative className="signalLogo" provider={provider as ProviderGlyphId} />;
}
export function ConnectionRow({ provider, name, description, connected, onConnect, onManage, connectedActionLabel, disabled = false }: {
  provider: string; name: string; description: string; connected: boolean; onConnect: () => void; onManage: () => void;
  connectedActionLabel?: string; disabled?: boolean;
}) {
  return <div className="signalConnection">
    <span className="signalLogoSlot"><SignalLogo provider={provider} /></span>
    <div className="signalConnection__label">
      <div>{name}{provider === "otel" && <small> · Recommended</small>}</div>
      <p>{description}</p>
    </div>
    <div className="signalConnection__actions">
      {connected && <span className="signalConnected"><IconCheck size={14} />Connected</span>}
      <Button aria-label={connected ? connectedActionLabel ?? `Manage ${name}` : `Connect ${name}`} disabled={!connected && disabled} onClick={connected ? onManage : onConnect}>
        {connected ? connectedActionLabel ?? "Manage" : "Connect"}
      </Button>
    </div>
  </div>;
}
export function PeriodSelect({ days, onChange }: { days: SignalPeriod; onChange: (days: SignalPeriod) => void }) {
  return <select aria-label="Date range" className="signalSelect" onChange={(e) => onChange(Number(e.target.value) as SignalPeriod)} value={days}>
    {signalPeriods.map((period) => <option key={period} value={period}>Last {period} days</option>)}
  </select>;
}
export function Severity({ level }: { level: SignalSeverity }) {
  return <span className={`signalSeverity signalSeverity--${level.slice(4)}`}><i />{level}</span>;
}

// Where the latest change to Signal's settings stands.
export type SaveStatus = { state: "saving" } | { state: "saved" } | { state: "error"; message: string } | null;

// A page of Signal's settings: a title, one line about it, then groups.
export function SettingsPage({ title, description, status = null, children }: {
  title: string; description: string; status?: SaveStatus; children: ReactNode;
}) {
  return <section className="signalSettingsPage">
    <header className="signalSettingsPage__head">
      <div><h2>{title}</h2><p>{description}</p></div>
      <span className="signalSaveStatus" role="status">{status?.state === "saving" ? "Saving…" : status?.state === "saved" ? "Saved" : ""}</span>
    </header>
    {status?.state === "error" && <p className="signalError" role="alert">{status.message}</p>}
    {children}
  </section>;
}

export function SettingsGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="signalSettingsGroup" aria-label={title}>
    <div className="signalSettingsGroup__head"><h3>{title}</h3>{action}</div>
    {children}
  </section>;
}

// A setting: what it is on the left, its control on the right, or below
// when `stacked`.
export function SettingsRow({ label, description, stacked = false, children }: {
  label: string; description: ReactNode; stacked?: boolean; children?: ReactNode;
}) {
  return <div className={`signalSettingsRow${stacked ? " signalSettingsRow--stacked" : ""}`}>
    <div className="signalSettingsRow__label"><strong>{label}</strong><span>{description}</span></div>
    {children}
  </div>;
}

// A connected source in a settings card, with more below it in `children`.
export function SourceRow({ provider, name, description, meta, action, children }: {
  provider: string; name: string; description: string; meta?: string; action: ReactNode; children?: ReactNode;
}) {
  return <div className="signalSourceRow" aria-label={name} role="group">
    <div className="signalSourceRow__main">
      <span className="signalLogoSlot"><SignalLogo provider={provider} /></span>
      <div className="signalSourceRow__label"><strong>{name}</strong><span>{description}</span></div>
      {meta && <span className="signalSourceRow__meta">{meta}</span>}
      {action}
    </div>
    {children}
  </div>;
}
