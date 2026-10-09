import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { AutomationOptions, AutomationTrigger, ConnectedAutomationTrigger } from "../automations-api";
import { scheduleWeekdayName } from "../../../../packages/core/src/automations/schedule";
import { defaultScheduleTrigger, isScheduleComplete, scheduleCron } from "../automation-configuration";
import { AutomationTriggerMenu, type TriggerEvent } from "./automation-trigger-menu";
import { AutomationTriggerConnect } from "./automation-trigger-connect";
import { AutomationTriggerIcon } from "./automation-trigger-icon";
import { AutomationResourcePicker } from "./automation-resource-picker";
import { AxiomWebhookDialog } from "./axiom-webhook-dialog";
import { SentryEnvironmentPicker } from "./sentry-environment-picker";
import { SlackAuthorPickers } from "./slack-author-picker";
import { movedElsewhereInApp } from "./popover-dismiss";
import { providerDisplayName } from "./provider-glyphs";
import { triggerTitle } from "../pages/automation-list-presentation";
import "./automation-trigger-editor.css";

type TriggerKind = AutomationTrigger["kind"];
type ConnectedTriggerKind = ConnectedAutomationTrigger["kind"];
type ScheduleTrigger = Extract<AutomationTrigger, { kind: "schedule" }>;

const hours = Array.from({ length: 24 }, (_, hour) => hour);
const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];

function ScheduleFields({ trigger, onChange }: { trigger: ScheduleTrigger; onChange: (trigger: ScheduleTrigger) => void }) {
  const cronInputId = useId();
  const cronHintId = useId();
  const cronInvalid = !isScheduleComplete(trigger);
  return <>
    <label className="automationTrigger__scheduleField">
      <span className="automationTrigger__fieldLabel">Frequency</span>
      <select className="automationTrigger__select" onChange={(event) => {
        const frequency = event.target.value as ScheduleTrigger["frequency"];
        onChange(frequency === "custom" ? { ...trigger, cron: trigger.cron || scheduleCron(trigger), frequency } : { ...trigger, frequency });
      }} value={trigger.frequency}>
        <option value="hourly">Every hour</option>
        <option value="daily">Every day</option>
        <option value="weekly">Every week</option>
        <option value="custom">Custom cron</option>
      </select>
    </label>
    {trigger.frequency === "custom" ? <div className="automationTrigger__scheduleField automationTrigger__scheduleField--cron">
      <label className="automationTrigger__fieldLabel" htmlFor={cronInputId}>Cron expression</label>
      <input aria-describedby={cronHintId} aria-invalid={cronInvalid} autoCapitalize="off" autoComplete="off" className="automationTrigger__input" id={cronInputId} onChange={(event) => onChange({ ...trigger, cron: event.target.value })} placeholder="0 9 * * 1-5" spellCheck={false} value={trigger.cron ?? ""} />
      <span className={cronInvalid ? "automationTrigger__hint automationTrigger__hint--error" : "automationTrigger__hint"} id={cronHintId}>{cronInvalid ? "Use five fields: minute, hour, day of month, month, day of week." : `Minute, hour, day of month, month, day of week, in ${trigger.timezone}.`}</span>
    </div> : null}
    {trigger.frequency === "weekly" ? <label className="automationTrigger__scheduleField">
      <span className="automationTrigger__fieldLabel">Day</span>
      <select className="automationTrigger__select" onChange={(event) => onChange({ ...trigger, weekday: Number(event.target.value) })} value={trigger.weekday}>
        {weekdayOrder.map((weekday) => <option key={weekday} value={weekday}>{scheduleWeekdayName(weekday)}</option>)}
      </select>
    </label> : null}
    {trigger.frequency === "daily" || trigger.frequency === "weekly" ? <label className="automationTrigger__scheduleField">
      <span className="automationTrigger__fieldLabel">Time</span>
      <select className="automationTrigger__select" onChange={(event) => onChange({ ...trigger, hour: Number(event.target.value) })} value={trigger.hour}>
        {hours.map((hour) => <option key={hour} value={hour}>{`${String(hour).padStart(2, "0")}:00`}</option>)}
      </select>
    </label> : null}
  </>;
}

// Axiom sends alerts to the connection's webhook, so its trigger has no
// resources to choose. The member adds the webhook as an Axiom notifier.
function AxiomTriggerFields({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);
  return <div className="automationTrigger__axiom">
    <p className="automationTrigger__hint">Runs when a monitor that uses the Responder notifier alerts.</p>
    <button className="button button--secondary button--small" onClick={() => setOpen(true)} type="button">Set up Axiom notifier</button>
    <AxiomWebhookDialog accountId={accountId} open={open} onClose={() => setOpen(false)} />
  </div>;
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
  const selectedIds = !connected || connected.kind === "axiom" ? [] : connected.kind === "sentry" ? connected.projectIds : connected.channelIds;
  const providerName = providerDisplayName(trigger.kind);
  const removeTrigger = <button aria-label={`Remove ${providerName} trigger`} className="automationCreate__iconButton" onClick={onRemove} type="button"><TrashIcon size={14} /></button>;

  const title = triggerTitle(trigger);

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
      {accounts.length > 1 || !account ? <select aria-label="Trigger connection" className="automationTrigger__account" value={account ? connected.integrationAccountId : ""} onChange={(event) => onChange(connected.kind === "axiom" ? { ...connected, integrationAccountId: event.target.value } : connected.kind === "sentry" ? { ...connected, excludedEnvironments: undefined, integrationAccountId: event.target.value, projectIds: [] } : connected.kind === "slack" ? { ...connected, ignoredAuthors: undefined, includedAuthors: undefined, integrationAccountId: event.target.value, channelIds: [] } : { ...connected, integrationAccountId: event.target.value, channelIds: [] })}>
        <option value="" disabled>Choose a workspace</option>
        {accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
      </select> : <span className="automationTrigger__account">{account?.displayName ?? "Not connected"}</span>}
      {removeTrigger}
    </div>
    {connected.kind === "axiom" ? <div className="automationTrigger__fields" ref={fieldsRef}>
      {account ? <AxiomTriggerFields accountId={connected.integrationAccountId} /> : null}
    </div> : <div className="automationTrigger__fields" ref={fieldsRef}>
      <AutomationResourcePicker key={`${connected.kind}:${connected.integrationAccountId}`} label={connected.kind === "sentry" ? "Project" : "Channel"} resources={resources} selected={selectedIds} onChange={(ids) => onChange(connected.kind === "sentry" ? { ...connected, projectIds: ids } : { ...connected, channelIds: ids })} onRefresh={connected.kind === "discord" ? undefined : () => onRefresh(connected.kind)} />
      {connected.kind === "sentry" && account ? <SentryEnvironmentPicker key={connected.integrationAccountId} accountId={connected.integrationAccountId} excluded={connected.excludedEnvironments ?? []} onChange={(excludedEnvironments) => onChange({ ...connected, excludedEnvironments })} /> : null}
      {connected.kind === "slack" && account && connected.channelIds.length > 0 ? <SlackAuthorPickers key={connected.integrationAccountId} accountId={connected.integrationAccountId} channelIds={connected.channelIds} ignored={connected.ignoredAuthors ?? []} included={connected.includedAuthors ?? []} onIgnoredChange={(ignoredAuthors) => onChange({ ...connected, ignoredAuthors })} onIncludedChange={(includedAuthors) => onChange({ ...connected, includedAuthors })} /> : null}
      {connected.kind === "discord" ? <AutomationTriggerConnect key={connected.integrationAccountId} kind="discord" name="Discord" onConnected={onConnected} label="Reconnect to refresh channels" /> : null}
    </div>}
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
      if (movedElsewhereInApp(rootRef.current, event.target)) onOpenChange(false);
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
      onChange([...triggers, defaultScheduleTrigger(event === "hourly" || event === "daily" || event === "custom" ? event : "weekly")]);
      return;
    }
    const account = options?.accounts.find((item) => item.provider === kind);
    if (kind === "axiom") {
      onChange([...triggers, { kind, integrationAccountId: account?.id ?? "" }]);
      return;
    }
    onChange([...triggers, kind === "sentry"
      ? { kind, integrationAccountId: account?.id ?? "", eventTypes: event === "both" ? ["new_issue", "regression"] : [event === "regression" ? "regression" : "new_issue"], projectIds: [] }
      : kind === "slack"
        ? { kind, integrationAccountId: account?.id ?? "", eventMode: event === "every_message" || event === "both" ? event : "mentions", channelIds: [] }
        : { kind, integrationAccountId: account?.id ?? "", channelIds: [] }]);
  }

  return <div className="automationTrigger" ref={rootRef} onBlur={(event) => {
    if (movedElsewhereInApp(event.currentTarget, event.relatedTarget)) onOpenChange(false);
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
