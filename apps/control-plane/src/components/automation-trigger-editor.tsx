import { type RefObject, useEffect, useId, useRef } from "react";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { AutomationOptions, AutomationTrigger, ConnectedAutomationTrigger } from "../automations-api";
import { scheduleWeekdayName } from "../../../../packages/core/src/automations/schedule";
import { defaultScheduleTrigger } from "../automation-configuration";
import { AutomationTriggerMenu, type TriggerEvent } from "./automation-trigger-menu";
import { AutomationTriggerConnect } from "./automation-trigger-connect";
import { AutomationTriggerIcon } from "./automation-trigger-icon";
import { AutomationResourcePicker } from "./automation-resource-picker";
import { providerDisplayName } from "./provider-glyphs";
import "./automation-trigger-editor.css";

type TriggerKind = AutomationTrigger["kind"];
type ConnectedTriggerKind = ConnectedAutomationTrigger["kind"];
type ScheduleTrigger = Extract<AutomationTrigger, { kind: "schedule" }>;

const hours = Array.from({ length: 24 }, (_, hour) => hour);
const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];

function ScheduleFields({ trigger, onChange }: { trigger: ScheduleTrigger; onChange: (trigger: ScheduleTrigger) => void }) {
  return <>
    <label className="automationTrigger__scheduleField">
      <span className="automationTrigger__fieldLabel">Frequency</span>
      <select className="automationTrigger__select" onChange={(event) => onChange({ ...trigger, frequency: event.target.value as ScheduleTrigger["frequency"] })} value={trigger.frequency}>
        <option value="hourly">Every hour</option>
        <option value="daily">Every day</option>
        <option value="weekly">Every week</option>
      </select>
    </label>
    {trigger.frequency === "weekly" ? <label className="automationTrigger__scheduleField">
      <span className="automationTrigger__fieldLabel">Day</span>
      <select className="automationTrigger__select" onChange={(event) => onChange({ ...trigger, weekday: Number(event.target.value) })} value={trigger.weekday}>
        {weekdayOrder.map((weekday) => <option key={weekday} value={weekday}>{scheduleWeekdayName(weekday)}</option>)}
      </select>
    </label> : null}
    {trigger.frequency !== "hourly" ? <label className="automationTrigger__scheduleField">
      <span className="automationTrigger__fieldLabel">Time</span>
      <select className="automationTrigger__select" onChange={(event) => onChange({ ...trigger, hour: Number(event.target.value) })} value={trigger.hour}>
        {hours.map((hour) => <option key={hour} value={hour}>{`${String(hour).padStart(2, "0")}:00`}</option>)}
      </select>
    </label> : null}
  </>;
}

// Most automations need one or two triggers; the server accepts up to ten.
export const maxAutomationTriggers = 10;

function TriggerCard({ options, trigger, onChange, onRemove, onConnected, onRefresh, fieldsRef }: {
  options: AutomationOptions | null;
  trigger: AutomationTrigger;
  onChange: (trigger: AutomationTrigger) => void;
  onRemove: () => void;
  onConnected: (kind: ConnectedTriggerKind, signal: AbortSignal) => Promise<boolean>;
  onRefresh: (kind: ConnectedTriggerKind) => Promise<void>;
  fieldsRef?: RefObject<HTMLDivElement | null>;
}) {
  const schedule = trigger.kind === "schedule" ? trigger : null;
  const connected = trigger.kind === "schedule" ? null : trigger;
  const accounts = options?.accounts.filter((account) => account.provider === connected?.kind) ?? [];
  const account = accounts.find((item) => item.id === connected?.integrationAccountId);
  const resources = options?.resources.filter((resource) => resource.integrationAccountId === connected?.integrationAccountId && resource.kind === (connected?.kind === "sentry" ? "sentry_project" : connected?.kind === "discord" ? "discord_channel" : "slack_channel")) ?? [];
  const selectedIds = connected ? connected.kind === "sentry" ? connected.projectIds : connected.channelIds : [];
  const providerName = providerDisplayName(trigger.kind);
  const removeTrigger = <button aria-label={`Remove ${providerName} trigger`} className="automationCreate__iconButton" onClick={onRemove} type="button"><TrashIcon size={14} /></button>;

  const title = connected?.kind === "slack"
    ? connected.eventMode === "every_message" ? "Slack message posted" : connected.eventMode === "mentions" ? "Slack app mentioned" : "Slack message posted or app mentioned"
    : connected?.kind === "sentry"
      ? connected.eventTypes.length === 2 ? "Sentry new issue or regression" : connected.eventTypes[0] === "regression" ? "Sentry issue regression" : "Sentry new issue"
      : "Discord automation command";

  if (schedule) return <div className="automationTrigger__card">
    <div className="automationTrigger__heading">
      <AutomationTriggerIcon kind="schedule" />
      <span className="automationTrigger__provider">Schedule</span>
      <span className="automationTrigger__account">{schedule.timezone}</span>
      {removeTrigger}
    </div>
    <div className="automationTrigger__fields" ref={fieldsRef}>
      <ScheduleFields onChange={onChange} trigger={schedule} />
    </div>
  </div>;
  if (!connected) return null;
  if (!accounts.length) return <div className="automationTrigger__disconnected" ref={fieldsRef}>
    <div className="automationTrigger__connectionCopy">
      <div><AutomationTriggerIcon kind={connected.kind} /><span>{title}</span></div>
      <p>Connect {providerName} to use this trigger</p>
    </div>
    <div className="automationTrigger__connectionActions">
      <AutomationTriggerConnect key={connected.kind} kind={connected.kind} name={providerName} onConnected={onConnected} />
      {removeTrigger}
    </div>
  </div>;
  return <div className="automationTrigger__card">
    <div className="automationTrigger__heading">
      <AutomationTriggerIcon kind={connected.kind} />
      <span className="automationTrigger__provider">{title}</span>
      {accounts.length > 1 || !account ? <select aria-label="Trigger connection" className="automationTrigger__account" value={account ? connected.integrationAccountId : ""} onChange={(event) => onChange(connected.kind === "sentry" ? { ...connected, integrationAccountId: event.target.value, projectIds: [] } : { ...connected, integrationAccountId: event.target.value, channelIds: [] })}>
        <option value="" disabled>Choose a workspace</option>
        {accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
      </select> : <span className="automationTrigger__account">{account?.displayName ?? "Not connected"}</span>}
      {removeTrigger}
    </div>
    <div className="automationTrigger__fields" ref={fieldsRef}>
      <AutomationResourcePicker key={`${connected.kind}:${connected.integrationAccountId}`} label={connected.kind === "sentry" ? "Project" : "Channel"} resources={resources} selected={selectedIds} onChange={(ids) => onChange(connected.kind === "sentry" ? { ...connected, projectIds: ids } : { ...connected, channelIds: ids })} onRefresh={connected.kind === "discord" ? undefined : () => onRefresh(connected.kind)} />
      {connected.kind === "discord" ? <AutomationTriggerConnect key={connected.integrationAccountId} kind="discord" name="Discord" onConnected={onConnected} label="Reconnect to refresh channels" /> : null}
    </div>
  </div>;
}

// Edits an automation's triggers. Each trigger starts a run on its own.
export function AutomationTriggerEditor({ options, triggers, onChange, open, onOpenChange, onConnected, onRefresh }: {
  options: AutomationOptions | null;
  onRefresh: (kind: ConnectedTriggerKind) => Promise<void>;
  onConnected: (kind: ConnectedTriggerKind, signal: AbortSignal) => Promise<boolean>;
  triggers: AutomationTrigger[];
  onChange: (triggers: AutomationTrigger[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const addedFieldsRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const focusAdded = useRef(false);
  const full = triggers.length >= maxAutomationTriggers;

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) onOpenChange(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (focusAdded.current) {
      addedFieldsRef.current?.querySelector<HTMLElement>("select, button, a")?.focus();
      focusAdded.current = false;
    }
  }, [triggers]);

  function choose(kind: TriggerKind, event: TriggerEvent) {
    onOpenChange(false);
    focusAdded.current = true;
    if (kind === "schedule") {
      onChange([...triggers, defaultScheduleTrigger(event === "hourly" || event === "daily" ? event : "weekly")]);
      return;
    }
    const account = options?.accounts.find((item) => item.provider === kind);
    onChange([...triggers, kind === "sentry"
      ? { kind, integrationAccountId: account?.id ?? "", eventTypes: event === "both" ? ["new_issue", "regression"] : [event === "regression" ? "regression" : "new_issue"], projectIds: [] }
      : kind === "slack"
        ? { kind, integrationAccountId: account?.id ?? "", eventMode: event === "every_message" || event === "both" ? event : "mentions", channelIds: [] }
        : { kind, integrationAccountId: account?.id ?? "", channelIds: [] }]);
  }

  return <div className="automationTrigger" ref={rootRef} onBlur={(event) => {
    // Focus moving to no element, such as another window or a browser
    // extension frame, leaves the menu open. Outside pointer clicks are
    // handled by the document listener above.
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false);
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      onOpenChange(false);
      buttonRef.current?.focus();
    }
  }}>
    {triggers.map((trigger, index) => <TriggerCard
      fieldsRef={index === triggers.length - 1 ? addedFieldsRef : undefined}
      key={index}
      onChange={(next) => onChange(triggers.map((current, position) => position === index ? next : current))}
      onConnected={onConnected}
      onRefresh={onRefresh}
      onRemove={() => { onChange(triggers.filter((_, position) => position !== index)); requestAnimationFrame(() => buttonRef.current?.focus()); }}
      options={options}
      trigger={trigger}
    />)}
    <div className="automationTrigger__chooser">
      <button aria-expanded={open} aria-controls={menuId} aria-haspopup="true" className={triggers.length ? "automationTrigger__change" : "automationCreate__add"} disabled={full} onClick={() => onOpenChange(!open)} ref={buttonRef} type="button"><PlusIcon size={16} />{triggers.length ? "Add another trigger" : "Add trigger"}</button>
      {triggers.length > 1 ? <span className="automationTrigger__hint">Any trigger starts a run</span> : null}
      {full ? <span className="automationTrigger__hint">Up to {maxAutomationTriggers} triggers per automation</span> : null}
      {open && !full ? <div aria-label="Choose a trigger" className="automationTrigger__menu" id={menuId} ref={menuRef}>
        <AutomationTriggerMenu onChoose={choose} />
      </div> : null}
    </div>
  </div>;
}
