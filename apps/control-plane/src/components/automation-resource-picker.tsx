import { useEffect, useId, useRef, useState } from "react";
import { ArrowClockwiseIcon, CaretDownIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { searchInputProps } from "./search-input-props";

export function AutomationResourcePicker({ label, resources, selected, onChange, onRefresh }: {
  label: "Channel" | "Project";
  resources: Array<{ externalId: string; displayName: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
  onRefresh?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const names = selected.map((value) => resources.find((resource) => resource.externalId === value)?.displayName ?? value);
  const search = query.trim().toLowerCase();
  const available = [...resources, ...selected.filter(id => !resources.some(resource => resource.externalId === id)).map(externalId => ({ externalId, displayName: `${externalId} (unavailable)` }))];
  const filtered = available.filter((resource) => `${resource.displayName} ${resource.externalId}`.toLowerCase().includes(search));
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  async function refresh() {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    setError(null);
    try { await onRefresh(); } catch { setError(`Could not refresh ${label.toLowerCase()}s. Try again.`); }
    finally { setRefreshing(false); }
  }
  return <div className="automationResourcePicker" ref={root} onBlur={(event) => {
    // Label clicks briefly blur the search before focusing their checkbox.
    // Outside pointer clicks are handled by the document listener above.
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); }
    if (open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(root.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []);
      const current = items.indexOf(document.activeElement as HTMLInputElement);
      const next = current < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}>
    <span className="automationTrigger__fieldLabel" id={`${id}-label`}>{label}</span>
    <button aria-labelledby={`${id}-label`} aria-describedby={`${id}-value`} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" className="automationResourcePicker__trigger" onClick={() => { setQuery(""); setOpen(!open); }} ref={button} type="button"><span id={`${id}-value`}>{names.length ? names.join(", ") : `Select ${label.toLowerCase()}`}</span><CaretDownIcon size={12} /></button>
    {open ? <div aria-label={`Choose ${label.toLowerCase()}s`} className="automationResourcePicker__popover" id={id} role="dialog">
      <label className="automationResourcePicker__search"><MagnifyingGlassIcon size={14} /><input {...searchInputProps} aria-label={`Search ${label.toLowerCase()}s`} placeholder={`Search ${label.toLowerCase()}s or paste ${label.toLowerCase()} ID…`} onChange={(event) => setQuery(event.target.value)} ref={input} value={query} /></label>
      <div className="automationResourcePicker__list"><span className="automationResourcePicker__group">{label}s</span>
        {filtered.map((resource) => <label className="automationResourcePicker__option" key={resource.externalId}><span>{resource.displayName}</span><input checked={selected.includes(resource.externalId)} onChange={() => onChange(selected.includes(resource.externalId) ? selected.filter((value) => value !== resource.externalId) : [...selected, resource.externalId])} type="checkbox" /></label>)}
        {!filtered.length ? <p className="automationResourcePicker__empty">{resources.length ? `No matching ${label.toLowerCase()}s.` : `No ${label.toLowerCase()}s available.`}</p> : null}
      </div>
      {error ? <p className="automationResourcePicker__error" role="alert">{error}</p> : null}
      {onRefresh ? <button className="automationResourcePicker__refresh" disabled={refreshing} onClick={() => void refresh()} type="button"><ArrowClockwiseIcon size={14} />{refreshing ? "Refreshing…" : `Refresh ${label.toLowerCase()}s`}</button> : null}
    </div> : null}
  </div>;
}
