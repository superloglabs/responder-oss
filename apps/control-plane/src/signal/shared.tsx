import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconCheck, IconX } from "@tabler/icons-react";
import { ProviderGlyph } from "../components/icons";
import type { ProviderGlyphId } from "../components/provider-glyphs";
import { Button } from "../design-system";

export function SignalLogo({ provider }: { provider: string }) {
  if (provider === "aws") return <span className="signalLogo signalAws" aria-hidden="true"><span>aws</span><svg width="28" height="8" viewBox="0 0 28 8"><path d="M2 1 Q14 9 25 1 M21 1 L26 0 L25 5" fill="none" stroke="#ff9900" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></span>;
  if (provider === "otel" || provider === "jira") return <img className="signalLogo" src={`/signal/${provider}.svg`} alt="" />;
  return <ProviderGlyph decorative className="signalLogo" provider={provider as ProviderGlyphId} />;
}
export function ConnectionRow({ provider, name, description, connected, onConnect, onManage, connectedActionLabel }: {
  provider: string; name: string; description: string; connected: boolean; onConnect: () => void; onManage: () => void;
  connectedActionLabel?: string;
}) {
  return <div className="signalConnection">
    <span className="signalLogoSlot"><SignalLogo provider={provider} /></span>
    <div className="signalConnection__label">
      <div>{name}{provider === "otel" && <small> · Recommended</small>}</div>
      <p>{description}</p>
    </div>
    <div className="signalConnection__actions">
      {connected && <span className="signalConnected"><IconCheck size={14} />Connected</span>}
      <Button aria-label={connected ? connectedActionLabel ?? `Manage ${name}` : `Connect ${name}`} onClick={connected ? onManage : onConnect}>
        {connected ? connectedActionLabel ?? "Manage" : "Connect"}
      </Button>
    </div>
  </div>;
}
export function SignalDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog aria-labelledby={titleId} className="signalDialog signal" onCancel={onClose} ref={ref}>
    <header><h2 id={titleId}>{title}</h2><button aria-label="Close dialog" className="signalPlainButton" onClick={onClose} type="button"><IconX size={16} /></button></header>
    {children}
  </dialog>;
}
export function PeriodSelect({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return <select aria-label="Date range" className="signalSelect" onChange={(e) => onChange(Number(e.target.value))} value={days}>
    <option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option>
  </select>;
}
export function Severity({ level }: { level: 2 | 3 }) {
  return <span className={`signalSeverity signalSeverity--${level}`}><i />SEV-{level}</span>;
}

