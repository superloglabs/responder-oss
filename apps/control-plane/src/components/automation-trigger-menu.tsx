import { type KeyboardEvent, useRef, useState } from "react";
import { CaretRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { AutomationTrigger } from "../automations-api";
import { AutomationTriggerIcon } from "./automation-trigger-icon";
import { searchInputProps } from "./search-input-props";

export type TriggerEvent = "every_message" | "mentions" | "both" | "new_issue" | "regression" | "alert" | "incident" | "ticket" | "opened" | "merged" | "command" | "hourly" | "daily" | "weekly" | "custom" | "request";
const providers = [
  { kind: "slack", name: "Slack", events: [
    { value: "every_message", label: "New message in channel" },
    { value: "mentions", label: "App mentioned" },
    { value: "both", label: "Message posted or app mentioned" },
  ] },
  { kind: "sentry", name: "Sentry", events: [
    { value: "new_issue", label: "New issue" },
    { value: "regression", label: "Issue regression" },
    { value: "both", label: "New issue or regression" },
  ] },
  { kind: "errors", name: "Errors", events: [
    { value: "new_issue", label: "New error" },
    { value: "regression", label: "Error regression" },
    { value: "both", label: "New error or regression" },
  ] },
  { kind: "axiom", name: "Axiom", events: [
    { value: "alert", label: "Monitor alert" },
  ] },
  { kind: "signoz", name: "SigNoz", events: [
    { value: "alert", label: "Alert fired" },
  ] },
  { kind: "honeycomb", name: "Honeycomb", events: [
    { value: "alert", label: "Trigger or SLO alert" },
  ] },
  { kind: "betterstack", name: "Better Stack", events: [
    { value: "incident", label: "Incident started" },
  ] },
  { kind: "devrev", name: "DevRev", events: [
    { value: "ticket", label: "New ticket" },
  ] },
  { kind: "github", name: "GitHub", events: [
    { value: "opened", label: "Pull request opened" },
    { value: "merged", label: "Pull request merged" },
    { value: "both", label: "Pull request opened or merged" },
  ] },
  { kind: "discord", name: "Discord", events: [
    { value: "command", label: "Automation command in channel" },
  ] },
  { kind: "schedule", name: "Schedule", events: [
    { value: "hourly", label: "Every hour" },
    { value: "daily", label: "Every day" },
    { value: "weekly", label: "Every week" },
    { value: "custom", label: "Custom cron" },
  ] },
  { kind: "webhook", name: "Webhook", events: [
    { value: "request", label: "Request received" },
  ] },
] as const;

function moveFocus(event: KeyboardEvent<HTMLElement>, selector: string) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  if (event.target instanceof HTMLInputElement && ["Home", "End"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(selector));
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : current < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

export function AutomationTriggerMenu({ onChoose, telemetry = false, webhook = true }: {
  onChoose: (kind: AutomationTrigger["kind"], event: TriggerEvent) => void;
  // Errors are offered only to workspaces with telemetry.
  telemetry?: boolean;
  // An automation has one webhook URL, so a second webhook is not offered.
  webhook?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = query.trim().toLowerCase();
  const filtered = providers.filter((provider) => (telemetry || provider.kind !== "errors") && (webhook || provider.kind !== "webhook")).map((provider) => ({
    ...provider,
    events: provider.events.filter((event) => provider.name.toLowerCase().includes(search) || event.label.toLowerCase().includes(search)),
  })).filter((provider) => provider.events.length);

  function focusEvents(kind: string) {
    setActive(kind);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-events="${kind}"] button`)?.focus());
  }

  return <div ref={root} onKeyDown={(event) => moveFocus(event, ".automationTrigger__providerOption")}>
    <label className="automationTrigger__search"><MagnifyingGlassIcon size={16} /><input {...searchInputProps} aria-label="Search triggers" placeholder="Search triggers…" value={query} onChange={(event) => { setQuery(event.target.value); setActive(null); }} /></label>
    <div role="menu" aria-label="Trigger providers" className="automationTrigger__providers">
      {filtered.map((provider) => <div className="automationTrigger__providerItem" key={provider.kind} onPointerEnter={(event) => { if (event.pointerType === "mouse") setActive(provider.kind); }}>
        <button aria-haspopup="menu" aria-expanded={active === provider.kind} className={`automationTrigger__providerOption${active === provider.kind ? " isActive" : ""}`} data-provider={provider.kind} onClick={() => focusEvents(provider.kind)} onFocus={() => setActive(provider.kind)} onKeyDown={(event) => {
          if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); focusEvents(provider.kind); }
        }} role="menuitem" type="button">
          <span className="automationTrigger__icon"><AutomationTriggerIcon kind={provider.kind} /></span><span>{provider.name}</span><CaretRightIcon size={14} />
        </button>
        {active === provider.kind ? <div className="automationTrigger__flyout" data-events={provider.kind}>
          <div aria-label={`${provider.name} events`} className="automationTrigger__events" role="menu" onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "Escape") {
              event.preventDefault(); event.stopPropagation();
              root.current?.querySelector<HTMLButtonElement>(`[data-provider="${provider.kind}"]`)?.focus();
              setActive(null);
            } else moveFocus(event, "button");
          }}>
            {provider.events.map((event) => <button key={event.value} onClick={() => onChoose(provider.kind, event.value)} role="menuitem" type="button">{event.label}</button>)}
          </div>
        </div> : null}
      </div>)}
      {!filtered.length ? <p className="automationTrigger__noResults" role="status">No triggers found.</p> : null}
    </div>
  </div>;
}
