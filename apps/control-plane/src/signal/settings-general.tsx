import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { IconPlus, IconX } from "@tabler/icons-react";
import { Button, SegmentedControl, Switch } from "../design-system";
import { canTurnOnSignal, fetchSignalBilling, type SignalBilling, type SignalCooldownHours, type SignalSeverity } from "./model";
import type { SettingsPageProps } from "./settings";
import { capOptions, cooldownOptions, severityOptions, skippedServiceError } from "./settings-model";
import { SettingsGroup, SettingsPage, SettingsRow } from "./shared";

const notesLimit = 2000;

export function SettingsGeneral({ data, save, fail, status }: SettingsPageProps) {
  const { settings } = data;
  const navigate = useNavigate();
  const [billing, setBilling] = useState<SignalBilling | null>(null);
  useEffect(() => {
    let current = true;
    // Only needed to turn Signal on, which loads it again if this failed.
    fetchSignalBilling().then((loaded) => { if (current) setBilling(loaded); }).catch(() => undefined);
    return () => { current = false; };
  }, []);

  // Turning on needs a plan, like the last setup step; turning off never does.
  async function setEnabled(enabled: boolean) {
    if (enabled) {
      let loaded = billing;
      if (!loaded) {
        try {
          loaded = await fetchSignalBilling();
          setBilling(loaded);
        } catch (failure) {
          fail(failure instanceof Error ? failure.message : "Could not load your plan.");
          return;
        }
      }
      if (!canTurnOnSignal(loaded)) {
        navigate("/signal/setup/plan");
        return;
      }
    }
    save({ enabled });
  }

  const max = settings.limits.dailyInvestigationCap;
  const cap = settings.dailyInvestigationCap ?? max;
  const needsPlan = !settings.enabled && billing !== null && !canTurnOnSignal(billing);

  return <SettingsPage title="General" description="Decide what Signal investigates and what it posts." status={status}>
    <SettingsGroup title="Signal">
      <div className="signalSettingsCard signalSettingsCard--rows">
        <SettingsRow label="Investigate and post findings"
          description={needsPlan ? "Choose a plan to turn Signal on." : "Turning it off keeps your setup and past findings."}>
          <Switch className="signalSwitch" aria-label="Investigate and post findings" checked={settings.enabled}
            label={settings.enabled ? "On" : "Off"} onCheckedChange={(enabled) => void setEnabled(enabled)} />
        </SettingsRow>
      </div>
    </SettingsGroup>

    <SettingsGroup title="Reporting">
      <div className="signalSettingsCard signalSettingsCard--rows">
        <SettingsRow label="Post findings from" description="Lower severities are kept on the Findings page and do not count toward your plan.">
          <span className="signalSeverityChoice">
            <SegmentedControl<SignalSeverity> aria-label="Post findings from" options={severityOptions}
              value={settings.minimumSeverity} onChange={(minimumSeverity) => save({ minimumSeverity })} />
          </span>
        </SettingsRow>
        <SettingsRow label="Investigations per day" description="A daily ceiling on investigations.">
          <select className="signalSettingsSelect" aria-label="Investigations per day" value={cap}
            onChange={(e) => {
              const value = Number(e.target.value);
              // The most allowed is stored as no cap, so it follows the limit.
              save({ dailyInvestigationCap: value === max ? null : value });
            }}>
            {capOptions(max, settings.dailyInvestigationCap).map((value) => <option key={value} value={value}>Up to {value}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label="Look again at dismissed problems" description="Sooner if the problem regresses or happens three times as often.">
          <select className="signalSettingsSelect" aria-label="Look again at dismissed problems" value={settings.dismissalCooldownHours}
            onChange={(e) => save({ dismissalCooldownHours: Number(e.target.value) as SignalCooldownHours })}>
            {cooldownOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </SettingsRow>
      </div>
    </SettingsGroup>

    <SettingsGroup title="Focus">
      <div className="signalSettingsCard signalSettingsCard--rows">
        <SettingsRow label="Skip these services" description="Signal does not investigate errors from these services. End a name with * to match a prefix.">
          <SkippedServices services={settings.skippedServices} onChange={(skippedServices) => save({ skippedServices })} />
        </SettingsRow>
        <Notes saved={settings.notes} onSave={(notes) => save({ notes })} />
      </div>
    </SettingsGroup>
  </SettingsPage>;
}

function SkippedServices({ services, onChange }: { services: string[]; onChange: (services: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function close() {
    setAdding(false);
    setValue("");
    setError("");
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const name = value.trim();
    const problem = skippedServiceError(name, services);
    if (problem) { setError(problem); return; }
    onChange([...services, name]);
    setValue("");
    setError("");
  }

  return <div className="signalSkipped">
    <div className="signalChips">
      {services.map((service) => <span className="signalChip" key={service}>
        <code>{service}</code>
        <button type="button" aria-label={`Stop skipping ${service}`} onClick={() => onChange(services.filter((name) => name !== service))}><IconX size={12} stroke={2} /></button>
      </span>)}
      {adding
        ? <form className="signalChipForm" onSubmit={add}>
          <input aria-label="Service to skip" autoFocus placeholder="service-name" value={value}
            aria-invalid={error ? true : undefined}
            onChange={(e) => { setValue(e.target.value); setError(""); }}
            onKeyDown={(e) => { if (e.key === "Escape") close(); }} />
          <Button type="submit" size="small">Add</Button>
        </form>
        : <button type="button" className="signalChipAdd" onClick={() => setAdding(true)}><IconPlus size={12} stroke={2} />Add service</button>}
    </div>
    {error && <p className="signalError" role="alert">{error}</p>}
  </div>;
}

function Notes({ saved, onSave }: { saved: string; onSave: (notes: string) => void }) {
  // The draft keeps the notes it started from: once other notes are saved it
  // is dropped, and a failed save brings it back.
  const [edit, setEdit] = useState<{ base: string; notes: string } | null>(null);
  const notes = edit?.base === saved ? edit.notes : saved;
  const setNotes = (next: string) => setEdit({ base: saved, notes: next });
  return <SettingsRow stacked label="Notes for Signal" description="Signal reads these before every investigation. Tell it what matters and what to ignore.">
    <textarea className="signalNotes" aria-label="Notes for Signal" maxLength={notesLimit} rows={3} value={notes}
      placeholder="Checkout and sign-in matter most. Ignore 404s from crawlers."
      onChange={(e) => setNotes(e.target.value)} />
    <div className="signalNotesActions">
      <span>{notes.length} / {notesLimit}</span>
      <Button disabled={notes === saved} onClick={() => onSave(notes)}>Save</Button>
    </div>
  </SettingsRow>;
}
