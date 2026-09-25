import { CalendarDotsIcon } from "@phosphor-icons/react";
import type { AutomationTrigger } from "../automations-api";
import { ProviderGlyph } from "./icons";

// Schedules have no provider, so they use a calendar icon.
export function AutomationTriggerIcon({ kind }: { kind: AutomationTrigger["kind"] }) {
  return kind === "schedule"
    ? <CalendarDotsIcon aria-hidden="true" className="automationTriggerIcon--schedule" size={16} />
    : <ProviderGlyph decorative provider={kind} />;
}
