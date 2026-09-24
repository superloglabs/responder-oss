import { useEffect, useId, useRef } from "react";
import { DiscordLogoIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { AutomationOptions, AutomationTrigger } from "../automations-api";
import { AutomationTriggerMenu, type TriggerEvent } from "./automation-trigger-menu";
import { AutomationTriggerConnect } from "./automation-trigger-connect";
import { AutomationResourcePicker } from "./automation-resource-picker";
import { ProviderGlyph } from "./icons";
import "./automation-trigger-editor.css";

const triggerChoices = [
  { kind: "slack", name: "Slack", description: "Message posted or app mentioned" },
  { kind: "sentry", name: "Sentry", description: "New issue or regression" },
  { kind: "discord", name: "Discord", description: "Automation command in a channel" },
] as const;

type TriggerKind = AutomationTrigger["kind"];

function TriggerIcon({ kind }: { kind: TriggerKind }) {
  return kind === "discord" ? <DiscordLogoIcon size={16} /> : <ProviderGlyph decorative provider={kind} />;
}

export function AutomationTriggerEditor({ options, trigger, onChange, open, onOpenChange, onConnected, onRefresh }: {
  options: AutomationOptions | null;
  onRefresh: (kind: TriggerKind) => Promise<void>;
  onConnected: (kind: TriggerKind) => Promise<boolean>;
  trigger: AutomationTrigger | null;
  onChange: (trigger: AutomationTrigger | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const focusConfiguration = useRef(false);

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
    if (focusConfiguration.current && trigger) {
      fieldsRef.current?.querySelector<HTMLElement>("select, button, a")?.focus();
      focusConfiguration.current = false;
    }
  }, [trigger]);

  function choose(kind: TriggerKind, event: TriggerEvent) {
    const account = options?.accounts.find((item) => item.provider === kind);
    onChange(kind === "sentry"
      ? { kind, integrationAccountId: account?.id ?? "", eventTypes: event === "both" ? ["new_issue", "regression"] : [event === "regression" ? "regression" : "new_issue"], projectIds: [] }
      : kind === "slack"
        ? { kind, integrationAccountId: account?.id ?? "", eventMode: event === "every_message" || event === "both" ? event : "mentions", channelIds: [] }
        : { kind, integrationAccountId: account?.id ?? "", channelIds: [] });
    onOpenChange(false);
    focusConfiguration.current = true;
  }

  const accounts = options?.accounts.filter((account) => account.provider === trigger?.kind) ?? [];
  const account = accounts.find((item) => item.id === trigger?.integrationAccountId);
  const resources = options?.resources.filter((resource) => resource.integrationAccountId === trigger?.integrationAccountId && resource.kind === (trigger?.kind === "sentry" ? "sentry_project" : trigger?.kind === "discord" ? "discord_channel" : "slack_channel")) ?? [];
  const selectedIds = trigger ? trigger.kind === "sentry" ? trigger.projectIds : trigger.channelIds : [];
  const providerName = trigger?.kind === "discord" ? "Discord" : triggerChoices.find((choice) => choice.kind === trigger?.kind)?.name;

  const title = trigger?.kind === "slack"
    ? trigger.eventMode === "every_message" ? "Slack message posted" : trigger.eventMode === "mentions" ? "Slack app mentioned" : "Slack message posted or app mentioned"
    : trigger?.kind === "sentry"
      ? trigger.eventTypes.length === 2 ? "Sentry new issue or regression" : trigger.eventTypes[0] === "regression" ? "Sentry issue regression" : "Sentry new issue"
      : "Discord automation command";


  return <div className="automationTrigger" ref={rootRef} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) onOpenChange(false);
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      onOpenChange(false);
      buttonRef.current?.focus();
    }
  }}>
    {trigger && !accounts.length ? <div className="automationTrigger__disconnected" ref={fieldsRef}>
      <div className="automationTrigger__connectionCopy">
        <div><TriggerIcon kind={trigger.kind} /><span>{title}</span></div>
        <p>Connect {providerName} to use this trigger</p>
      </div>
      <div className="automationTrigger__connectionActions">
        <AutomationTriggerConnect key={trigger.kind} kind={trigger.kind} name={providerName ?? trigger.kind} onConnected={onConnected} />
        <button aria-label={`Remove ${providerName} trigger`} className="automationCreate__iconButton" onClick={() => { onChange(null); requestAnimationFrame(() => buttonRef.current?.focus()); }} type="button"><TrashIcon size={14} /></button>
      </div>
    </div> : trigger ? <div className="automationTrigger__card">
      <div className="automationTrigger__heading">
        <TriggerIcon kind={trigger.kind} />
        <span className="automationTrigger__provider">{title}</span>
        {accounts.length > 1 || !account ? <select aria-label="Trigger connection" className="automationTrigger__account" value={account ? trigger.integrationAccountId : ""} onChange={(event) => onChange(trigger.kind === "sentry" ? { ...trigger, integrationAccountId: event.target.value, projectIds: [] } : { ...trigger, integrationAccountId: event.target.value, channelIds: [] })}>
          <option value="" disabled>Choose a workspace</option>
          {accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select> : <span className="automationTrigger__account">{account?.displayName ?? "Not connected"}</span>}
        <button aria-label={`Remove ${providerName} trigger`} className="automationCreate__iconButton" onClick={() => { onChange(null); requestAnimationFrame(() => buttonRef.current?.focus()); }} type="button"><TrashIcon size={14} /></button>
      </div>
      <div className="automationTrigger__fields" ref={fieldsRef}>
        <AutomationResourcePicker key={`${trigger.kind}:${trigger.integrationAccountId}`} label={trigger.kind === "sentry" ? "Project" : "Channel"} resources={resources} selected={selectedIds} onChange={(ids) => onChange(trigger.kind === "sentry" ? { ...trigger, projectIds: ids } : { ...trigger, channelIds: ids })} onRefresh={trigger.kind === "discord" ? undefined : () => onRefresh(trigger.kind)} />
      </div>
    </div> : null}
    <div className="automationTrigger__chooser">
      <button aria-expanded={open} aria-controls={menuId} aria-haspopup="true" className={trigger ? "automationTrigger__change" : "automationCreate__add"} onClick={() => onOpenChange(!open)} ref={buttonRef} type="button"><PlusIcon size={16} />{trigger ? "Change trigger" : "Add trigger"}</button>
      {trigger ? <span className="automationTrigger__hint">One trigger per automation</span> : null}
      {open ? <div aria-label="Choose a trigger" className="automationTrigger__menu" id={menuId} ref={menuRef}>
        <AutomationTriggerMenu onChoose={choose} />
      </div> : null}
    </div>
  </div>;
}
